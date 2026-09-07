import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  JSTS_SEMANTIC_PROCESS_BUILD_IDENTITY,
  JSTS_SEMANTIC_PROCESS_PROTOCOL_VERSION,
  createJavascriptTypescriptSemanticProcessTransport,
} from "../packages/plugin-javascript-typescript/src/index.js";
import { canonicalSha256 } from "@urdira/plugin-sdk";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function describeRequest(deadline = new Date(Date.now() + 30_000).toISOString()) {
  return {
    protocol_version: "1.0.0",
    request_id: "semantic-process:describe",
    request_digest: "sha256:semantic-process-describe",
    call: "describe" as const,
    deadline,
    cancellation_id: "cancel:semantic-process-describe",
    payload: {},
  };
}

async function fakeSemanticWorker(behavior: "wrong-handshake" | "hang" | "crash"): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "urdira-semantic-worker-test-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "worker.mjs");
  const source = `
    import { deserialize, serialize } from "node:v8";
    let buffered = Buffer.alloc(0);
    const send = (message) => {
      const payload = serialize(message);
      const frame = Buffer.allocUnsafe(payload.length + 4);
      frame.writeUInt32BE(payload.length, 0);
      payload.copy(frame, 4);
      process.stdout.write(frame);
    };
    process.stdin.on("data", (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      while (buffered.length >= 4) {
        const length = buffered.readUInt32BE(0);
        if (buffered.length < length + 4) return;
        const message = deserialize(buffered.subarray(4, length + 4));
        buffered = buffered.subarray(length + 4);
        if (message.kind === "handshake") {
          send({
            protocol_version: ${JSON.stringify(JSTS_SEMANTIC_PROCESS_PROTOCOL_VERSION)},
            kind: "handshake_ack",
            request_id: message.request_id,
            build_identity: ${JSON.stringify(behavior === "wrong-handshake" ? "jsts-semantic:wrong" : JSTS_SEMANTIC_PROCESS_BUILD_IDENTITY)},
            node_version: process.versions.node,
            max_message_bytes: message.max_message_bytes,
          });
        } else if (message.kind === "invoke" && ${JSON.stringify(behavior)} === "crash") {
          process.stderr.write("semantic-worker-test-crash-detail\\n");
          process.exit(23);
        } else if (message.kind === "shutdown") {
          send({ protocol_version: ${JSON.stringify(JSTS_SEMANTIC_PROCESS_PROTOCOL_VERSION)}, kind: "shutdown_ack", request_id: message.request_id });
          setImmediate(() => process.exit(0));
        }
      }
    });
  `;
  await writeFile(path, source, "utf8");
  return path;
}

describe("JavaScript/TypeScript semantic process transport", () => {
  it("runs describe, cancellation, and reset in the isolated Node process", async () => {
    const transport = createJavascriptTypescriptSemanticProcessTransport({
      node_executable: process.execPath,
      worker: {
        compatibility_declaration_digest: "sha256:compat",
        registry_contribution_digest: "sha256:registry",
        runtime_executable_binding_digest: `sha256:${"a".repeat(64)}`,
      },
    });
    try {
    await expect(transport.ready()).resolves.toBeUndefined();
    expect(transport.process_id).toBeGreaterThan(0);
      const described = await transport.invoke(describeRequest("2099-01-01T00:00:00.000Z")) as { readonly payload: { readonly plugin_id: string; readonly compatibility_declaration_digest: string } };
      expect(described.payload).toMatchObject({
        plugin_id: "urdira:javascript_typescript",
        compatibility_declaration_digest: "sha256:compat",
      });
      await expect(transport.cancel({ cancellation_id: "cancel:not-active" })).resolves.toBeUndefined();
      await expect(transport.reset()).resolves.toEqual({ state_reset: true });
      expect(transport.is_healthy()).toBe(true);
    } finally {
      await transport.terminate();
    }
  });

  it("walks a result-heavy Rust-authoritative group as owner streams so physical staging can repartition it", async () => {
    const transport = createJavascriptTypescriptSemanticProcessTransport({
      node_executable: process.execPath,
      worker: {
        runtime_executable_binding_digest: `sha256:${"b".repeat(64)}`,
        analysis_digest: `sha256:${"c".repeat(64)}`,
        analysis_configuration_digest: `sha256:${"d".repeat(64)}`,
      },
    });
    const declarations = (prefix: string) => Array.from({ length: 1_200 }, (_, index) => `export function ${prefix}${index}(value: number): number { return value; }\nexport const ${prefix}Result${index} = ${prefix}${index}(${index});`).join("\n");
    const sources = [
      { path: "src/a.ts", text: declarations("a"), artifact_id: "artifact:a", artifact_version_id: "version:a" },
      { path: "src/b.ts", text: declarations("b"), artifact_id: "artifact:b", artifact_version_id: "version:b" },
    ].map((file) => ({ ...file, content_hash: `sha256:${createHash("sha256").update(file.text).digest("hex")}` }));
    const scope = { authority: "urdira:jsts-syntax-worker", changed_paths: sources.map((file) => file.path), affected_paths: sources.map((file) => file.path) };
    try {
      await transport.invoke({
        protocol_version: "1.0.0", request_id: "semantic-group:prepare", request_digest: `sha256:${"e".repeat(64)}`,
        call: "analyze_closure", deadline: "2099-01-01T00:00:00.000Z", cancellation_id: "cancel:semantic-group:prepare",
        payload: { files: sources, root_names: sources.map((file) => file.path), publication_stage_id: "jsts:structural_stage_2", rust_semantic_scope: scope },
      });
      const ownerFiles = sources.map(({ text: _text, ...file }) => file);
      const requests = sources.map((owner, index) => ({
        protocol_version: "1.0.0",
        request_id: `semantic-group:owner:${index}`,
        request_digest: `sha256:${String(index + 1).repeat(64)}`,
        call: "analyze_artifact" as const,
        deadline: "2099-01-01T00:00:00.000Z",
        cancellation_id: `cancel:semantic-group:owner:${index}`,
        payload: {
          files: ownerFiles,
          root_names: sources.map((file) => file.path),
          owner_path: owner.path,
          publication_stage_id: "jsts:structural_stage_2",
          rust_semantic_scope_ref: canonicalSha256(scope),
          work_item: {
            candidate_generation_id: "candidate:semantic-group", workspace_id: "workspace:semantic-group",
            artifact_id: owner.artifact_id, target_artifact_version_id: owner.artifact_version_id,
            work_item_id: `work:semantic-group:${index}`, plugin_id: "urdira:javascript_typescript", plugin_version: "0.5.0",
            expected_replacement_scopes: [{
              replacement_scope_id: `scope:semantic-group:${index}`, owner_artifact_id: owner.artifact_id,
              owner_artifact_version_id: owner.artifact_version_id, capability: "core:call_relationships",
              record_categories: ["entity", "relation", "diagnostic"],
              record_kinds: ["jsts:relation_call", "jsts:relation_references", "jsts:relation_inherits", "jsts:relation_implements"],
              base_record_set_digest: `sha256:${"0".repeat(64)}`, output_completeness: "complete",
            }],
          },
          accepted_manifest: {
            plugin_input_access_manifest_id: `manifest:semantic-group:${index}`,
            manifest_digest: `sha256:${String(index + 3).repeat(64)}`,
            artifact_version_entries: ownerFiles.map((file) => ({ artifact_version_id: file.artifact_version_id })),
            record_entries: [],
          },
        },
      }));
      const streams = await transport.invokeFactDeltaStreamGroup(requests);
      expect(JSTS_SEMANTIC_PROCESS_PROTOCOL_VERSION).toBe("1.9.0");
      expect(JSTS_SEMANTIC_PROCESS_BUILD_IDENTITY).toContain("native-observation-projection");
      expect(streams.map((stream) => stream.header.work_item_id)).toEqual(["work:semantic-group:0", "work:semantic-group:1"]);
      // Owners remain independently iterable even though one bounded
      // semantic_group_next response may drain several complete owner streams.
      let resultRows = 0;
      for (const stream of streams) {
        const batches = [];
        for await (const batch of stream.batches) { batches.push(batch); resultRows += batch.row_count; }
        expect(batches.at(-1)?.final).toBe(true);
      }
      // The checker lookup group is intentionally larger than one physical
      // acceptance transaction. Owner framing must survive so the generic
      // acceptance layer can seal a transaction before the next owner.
      expect(resultRows).toBeGreaterThan(4_096);
      expect(transport.is_healthy()).toBe(true);
    } finally {
      await transport.terminate();
    }
  });

  it("fails closed when the handshake build identity is not exact", async () => {
    const transport = createJavascriptTypescriptSemanticProcessTransport({
      node_executable: process.execPath,
      worker_entrypoint: await fakeSemanticWorker("wrong-handshake"),
      worker: {},
    });
    await expect(transport.ready()).rejects.toThrow(/build identity/iu);
    expect(transport.is_healthy()).toBe(false);
    await transport.terminate();
  });

  it("enforces request deadlines by rejecting work and terminating the checker", async () => {
    const transport = createJavascriptTypescriptSemanticProcessTransport({
      node_executable: process.execPath,
      worker_entrypoint: await fakeSemanticWorker("hang"),
      worker: {},
    });
    await transport.ready();
    await expect(transport.invoke(describeRequest(new Date(Date.now() + 50).toISOString()))).rejects.toThrow(/deadline/iu);
    expect(transport.is_healthy()).toBe(false);
    await transport.terminate();
  });

  it("rejects every in-flight request when the checker process crashes", async () => {
    const transport = createJavascriptTypescriptSemanticProcessTransport({
      node_executable: process.execPath,
      worker_entrypoint: await fakeSemanticWorker("crash"),
      worker: {},
    });
    await transport.ready();
    await expect(transport.invoke(describeRequest())).rejects.toThrow(/exited.*semantic-worker-test-crash-detail/iu);
    expect(transport.is_healthy()).toBe(false);
    await transport.terminate();
  });

  it("rejects an oversized request before writing it to the child", async () => {
    const transport = createJavascriptTypescriptSemanticProcessTransport({
      node_executable: process.execPath,
      max_message_bytes: 1_024,
      worker: {},
    });
    try {
      await transport.ready();
      await expect(transport.invoke({ ...describeRequest(), payload: { text: "x".repeat(4_096) } })).rejects.toThrow(/message limit/iu);
      expect(transport.is_healthy()).toBe(true);
    } finally {
      await transport.terminate();
    }
  });

  it("rejects an ambient or relative structural-kernel binding before spawning", () => {
    expect(() => createJavascriptTypescriptSemanticProcessTransport({
      node_executable: process.execPath,
      structural_kernel_addon_path: "./urdira-native.node",
      worker: {},
    })).toThrow(/addon path must be absolute/iu);
  });
});
