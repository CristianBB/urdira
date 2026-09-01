import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  RUST_WORKER_PROTOCOL_IDENTITY,
  RUST_WORKER_PROTOCOL_VERSION,
  MAX_RUST_WORKER_FRAME_CHUNK_BYTES,
  RustWorkerFrameDecoder,
  decodeRustWorkerMessage,
  encodeRustWorkerMessage,
} from "../packages/plugin-javascript-typescript/src/rust-protocol.js";
import {
  createRustSyntaxHandshake,
  createRustSyntaxAnalyzeRequest,
  createRustSyntaxCommitAnalysisRequest,
  createRustSyntaxFactsRequest,
  createRustSyntaxFactsGroupRequest,
  validateRustSyntaxWorkerMessage,
} from "../packages/plugin-javascript-typescript/src/syntax-protocol.js";

const SHA256 = `sha256:${"1".repeat(64)}`;

describe("JavaScript/TypeScript Rust worker protocol", () => {
  it("round-trips a message through bounded length-prefixed urdira.ipc.v2 chunks", () => {
    const request = createRustSyntaxAnalyzeRequest({
      request_id: "request:chunked",
      cancellation_id: "cancel:chunked",
      project_key: "project:one",
      configuration_digest: `sha256:${"1".repeat(64)}`,
      root_names: ["src/index.ts"],
      files: [{
        path: "src/index.ts",
        artifact_id: "artifact:index",
        artifact_version_id: "version:index",
        content_digest: `sha256:${"1".repeat(64)}`,
        source_blob_path: resolve(".urdira-test-source"),
        byte_length: 1024,
      }],
      max_output_bytes: 4 * 1024 * 1024,
      max_files: 8,
      max_source_bytes: 1025,
    });
    const envelope = { request, padding: "a".repeat(MAX_RUST_WORKER_FRAME_CHUNK_BYTES * 2 + 19) };

    const frames = encodeRustWorkerMessage(envelope, {
      stream_id: 7,
      cancellation_id: request.cancellation_id,
      byte_budget: 4 * 1024 * 1024,
      in_flight_budget: 4 * 1024 * 1024,
    });
    expect(frames.length).toBeGreaterThan(1);
    expect(frames.every((frame) => frame.readUInt32BE(0) <= MAX_RUST_WORKER_FRAME_CHUNK_BYTES)).toBe(true);

    const decoder = new RustWorkerFrameDecoder();
    const messages = frames.flatMap((frame) => {
      const split = Math.max(1, Math.floor(frame.byteLength / 3));
      return [frame.subarray(0, split), frame.subarray(split)].flatMap((chunk) => decoder.push(chunk));
    });
    expect(messages).toHaveLength(1);
    expect(decodeRustWorkerMessage(messages[0]!.payload)).toEqual(envelope);
  });

  it("rejects unknown message fields and mismatched source digests", () => {
    expect(() => validateRustSyntaxWorkerMessage({
      kind: "reset",
      request_id: "request:reset",
      project_key: "project:one",
      unexpected: true,
    })).toThrow(/closed|unknown|field/iu);

    expect(() => createRustSyntaxAnalyzeRequest({
      request_id: "request:digest",
      cancellation_id: "cancel:digest",
      project_key: "project:one",
      configuration_digest: `sha256:${"2".repeat(64)}`,
      root_names: ["src/index.ts"],
      files: [{ path: "src/index.ts", artifact_id: "artifact:index", artifact_version_id: "version:index", content_digest: "invalid", source_blob_path: resolve(".urdira-test-source"), byte_length: 23 }],
      max_output_bytes: 1024,
      max_files: 1,
      max_source_bytes: 1024,
    })).toThrow(/digest/iu);
  });

  it("rejects malformed framed messages before they reach a worker", () => {
    const options = { stream_id: 1, cancellation_id: "cancel:protocol", byte_budget: 1024, in_flight_budget: 1024 } as const;
    expect(() => encodeRustWorkerMessage({}, { ...options, stream_id: -1 })).toThrow(/uint32/iu);
    expect(() => encodeRustWorkerMessage({}, { ...options, byte_budget: 0 })).toThrow(/positive uint32/iu);
    expect(() => encodeRustWorkerMessage({}, { ...options, cancellation_id: "bad\nvalue" })).toThrow(/cancellation_id/iu);
    expect(() => encodeRustWorkerMessage({}, { ...options, cancellation_id: "é".repeat(121) })).toThrow(/too long/iu);
    expect(() => encodeRustWorkerMessage("x".repeat(2_000), options)).toThrow(/exceeds/iu);

    const decoder = new RustWorkerFrameDecoder();
    expect(decoder.push(new Uint8Array())).toEqual([]);
    expect(() => decoder.finish()).not.toThrow();
    expect(() => decoder.push(Buffer.from([0, 0, 0, 0]))).toThrow(/frame length/iu);
    expect(() => decodeRustWorkerMessage(Buffer.from('{"a":1,"a":2}', "utf8"))).toThrow(/duplicate/iu);
    expect(() => decodeRustWorkerMessage(Buffer.from('{"a":', "utf8"))).toThrow();
    expect(() => decodeRustWorkerMessage(Buffer.from("1 trailing", "utf8"))).toThrow(/trailing/iu);
  });

  it("rejects malformed protobuf framing and JSON tokens", () => {
    const frame = (body: ArrayLike<number>): Buffer => { const bytes = Buffer.from(body); const output = Buffer.alloc(4 + bytes.byteLength); output.writeUInt32BE(bytes.byteLength, 0); bytes.copy(output, 4); return output; };
    const malformed = [
      [[0x08], /varint is truncated/iu],
      [Array.from({ length: 5 }, () => 0x80), /varint exceeds/iu],
      [[0x50, 0], /unknown or duplicate/iu],
      [[0x0a, 0], /wrong wire/iu],
      [[0x38, 0], /wrong wire/iu],
      [[0x3a, 2, 0xff], /bytes are truncated/iu],
      [[0x08, 2], /version or required/iu],
    ] as const;
    for (const [body, error] of malformed) expect(() => new RustWorkerFrameDecoder().push(frame(body))).toThrow(error);

    const encoded = encodeRustWorkerMessage({}, { stream_id: 1, cancellation_id: "cancel:malformed", byte_budget: 1024, in_flight_budget: 1024 })[0]!;
    const invalidFinal = Buffer.from(encoded); invalidFinal[invalidFinal.length - 1] = 2;
    expect(() => new RustWorkerFrameDecoder().push(invalidFinal)).toThrow(/final flag/iu);
    expect(() => new RustWorkerFrameDecoder(1).push(encoded)).toThrow(/mandatory budget/iu);
    const outOfOrder = Buffer.from(encoded);
    const sequenceTag = outOfOrder.indexOf(0x18, 4);
    if (sequenceTag >= 0) outOfOrder[sequenceTag + 1] = 1;
    expect(() => new RustWorkerFrameDecoder().push(outOfOrder)).toThrow(/sequence and offset zero/iu);
    const incomplete = new RustWorkerFrameDecoder(); incomplete.push(encoded.subarray(0, encoded.length - 1));
    expect(() => incomplete.finish()).toThrow(/incomplete/iu);

    expect(() => decodeRustWorkerMessage(Buffer.from('"bad', "utf8"))).toThrow(/unterminated/iu);
    expect(() => decodeRustWorkerMessage(Buffer.from('"a\n"', "utf8"))).toThrow(/string is invalid/iu);
    expect(decodeRustWorkerMessage(Buffer.from("{}", "utf8"))).toEqual({});
    expect(() => decodeRustWorkerMessage(Buffer.from('{"a" 1}', "utf8"))).toThrow(/object is invalid/iu);
    expect(() => decodeRustWorkerMessage(Buffer.from('{"a":1 "b":2}', "utf8"))).toThrow(/object is invalid/iu);
    expect(() => decodeRustWorkerMessage(Buffer.from("[1 2]", "utf8"))).toThrow(/array is invalid/iu);
    expect(() => decodeRustWorkerMessage(Buffer.from("{a:1}", "utf8"))).toThrow(/JSON string is invalid/iu);
  });

  it("accepts empty source files without weakening positive transport budgets", () => {
    const input = {
      request_id: "request:empty",
      cancellation_id: "cancel:empty",
      project_key: "project:one",
      configuration_digest: SHA256,
      root_names: ["src/empty.ts"],
      files: [{
        path: "src/empty.ts",
        artifact_id: "artifact:empty",
        artifact_version_id: "version:empty",
        content_digest: SHA256,
        source_blob_path: resolve(".urdira-test-empty-source"),
        byte_length: 0,
      }],
      max_output_bytes: 1024,
      max_files: 1,
      max_source_bytes: 1,
    } as const;
    const request = createRustSyntaxAnalyzeRequest(input);

    expect(request.files[0]?.byte_length).toBe(0);
    expect(() => createRustSyntaxAnalyzeRequest({ ...input, max_source_bytes: 0 })).toThrow(/positive integer/iu);
  });

  it("validates every closed control response and the exact handshake budgets", () => {
    expect(createRustSyntaxHandshake("request:handshake", "worker:build")).toEqual({
      kind: "handshake",
      request_id: "request:handshake",
      protocol_identity: RUST_WORKER_PROTOCOL_IDENTITY,
      protocol_version: RUST_WORKER_PROTOCOL_VERSION,
      expected_worker_build_identity: "worker:build",
      max_frame_chunk_bytes: MAX_RUST_WORKER_FRAME_CHUNK_BYTES,
      max_message_bytes: 16 * 1024 * 1024,
    });

    const messages = [
      {
        kind: "handshake_ack",
        request_id: "request:handshake",
        protocol_identity: RUST_WORKER_PROTOCOL_IDENTITY,
        protocol_version: RUST_WORKER_PROTOCOL_VERSION,
        worker_build_identity: "worker:build",
        max_frame_chunk_bytes: MAX_RUST_WORKER_FRAME_CHUNK_BYTES,
        max_message_bytes: 16 * 1024 * 1024,
      },
      { kind: "cancel_ack", request_id: "request:cancel", cancellation_id: "cancel:one" },
      { kind: "cancelled", request_id: "request:analyze", cancellation_id: "cancel:one" },
      { kind: "reset_ack", request_id: "request:reset", reset_projects: 0 },
      { kind: "shutdown_ack", request_id: "request:shutdown" },
      { kind: "error", request_id: "request:error", code: "resource_exhausted", message: "bounded failure" },
    ] as const;

    for (const message of messages) expect(validateRustSyntaxWorkerMessage(message)).toBe(message);
    expect(() => validateRustSyntaxWorkerMessage(null)).toThrow(/closed object/iu);
    expect(() => validateRustSyntaxWorkerMessage({ ...messages[0], protocol_version: 1 })).toThrow(/protocol identity/iu);
    expect(() => validateRustSyntaxWorkerMessage({ ...messages[3], reset_projects: -1 })).toThrow(/reset_projects/iu);
    expect(() => validateRustSyntaxWorkerMessage({ ...messages[5], code: "invented" })).toThrow(/error code/iu);
    expect(() => validateRustSyntaxWorkerMessage({ kind: "invented", request_id: "request:unknown" })).toThrow(/unknown message variant/iu);
  });

  it("validates path-only analysis results and Rust-built paged fact rows", () => {
    const result = {
      kind: "analysis_result",
      request_id: "request:analysis",
      cancellation_id: "cancel:analysis",
      project_key: "project:one",
      analysis_token: "analysis:one",
      build: "full",
      reset_reason: "initial",
      changed_files: ["src/dependency.ts", "src/index.ts"],
      affected_files: ["src/dependency.ts", "src/index.ts"],
      metrics: {
        bytes_read: 31,
        bytes_transferred: 0,
        bytes_copied: 0,
        bytes_decoded: 31,
        bytes_retained: 31,
      },
    } as const;
    const page = {
      kind: "facts_result",
      request_id: "request:facts",
      cancellation_id: "cancel:facts",
      project_key: "project:one",
        path: "src/index.ts",
        content_digest: SHA256,
        language: "typescript",
        script_kind: "ts",
        byte_length: 31,
        parsed: true,
        direct_imports: [{
          specifier: "./dependency.js",
          target_path: "src/dependency.ts",
          kind: "import",
          start: 0,
          end: 24,
        }],
        records: [{
          proposal_record_key: "jsts:record:jsts:module:src/index.ts:0:src/index.ts",
          category: "entity",
          kind: "jsts:entity_container",
          universal_kind: "core:container",
          facets: '["core:declaration","core:definition"]',
          schema_version: 1,
          source_span: '{"end":31,"path":"src/index.ts","start":0}',
          identity_key: "jsts:module:src/index.ts:0:src/index.ts",
          body: { name: "src/index.ts", kind: "module", language: "typescript", path: "src/index.ts", start: 0, end: 31 },
          evidence_references: '[{"end":31,"path":"src/index.ts","start":0}]',
        }],
        dependencies: [],
        diagnostics: [{ message: "fixture diagnostic", start: 25, end: 30 }],
      next_cursor: { imports_offset: 1, records_offset: 1, dependencies_offset: 0 },
      metrics: {
        bytes_transferred: 31,
        bytes_copied: 0,
      },
    } as const;

    expect(validateRustSyntaxWorkerMessage(result)).toBe(result);
    expect(validateRustSyntaxWorkerMessage(page)).toBe(page);
    expect(createRustSyntaxFactsRequest({
      request_id: "request:facts",
      cancellation_id: "cancel:facts",
      project_key: "project:one",
      path: "src/index.ts",
      cursor: { imports_offset: 0, records_offset: 0, dependencies_offset: 0 },
      max_output_bytes: 4 * 1024 * 1024,
      max_rows: 4096,
    })).toMatchObject({ kind: "read_facts", path: "src/index.ts", max_rows: 4096 });
    expect(createRustSyntaxFactsGroupRequest({
      request_id: "request:facts-group",
      cancellation_id: "cancel:facts-group",
      project_key: "project:one",
      entries: [{ path: "src/index.ts" }, { path: "src/dependency.ts", cursor: { imports_offset: 1, records_offset: 2, dependencies_offset: 0 } }],
      max_output_bytes: 16 * 1024 * 1024,
      max_rows: 4096,
    })).toMatchObject({ kind: "read_facts_group", entries: [{ path: "src/index.ts" }, { path: "src/dependency.ts" }] });
    const group = {
      kind: "facts_group_result",
      request_id: "request:facts",
      cancellation_id: "cancel:facts",
      project_key: "project:one",
      pages: [page],
      next_request_index: 1,
      metrics: { bytes_transferred: 1024, bytes_copied: 1024 },
    } as const;
    expect(validateRustSyntaxWorkerMessage(group)).toBe(group);
    expect(() => validateRustSyntaxWorkerMessage({ ...group, pages: [page, page] })).toThrow(/repeats an owner/iu);
    expect(() => createRustSyntaxFactsGroupRequest({
      request_id: "request:facts-group",
      cancellation_id: "cancel:facts-group",
      project_key: "project:one",
      entries: [{ path: "src/index.ts" }, { path: "src/index.ts" }],
      max_output_bytes: 16 * 1024 * 1024,
      max_rows: 4096,
    })).toThrow(/repeats/iu);
    expect(createRustSyntaxCommitAnalysisRequest({ request_id: "request:commit", project_key: "project:one", analysis_token: "analysis:one" })).toEqual({ kind: "commit_analysis", request_id: "request:commit", project_key: "project:one", analysis_token: "analysis:one" });
    const utf8OrderedPaths = ["A.ts", "[a].ts", "_a.ts", "a.ts", "z.ts", "é.ts"];
    expect(validateRustSyntaxWorkerMessage({
      ...result,
      changed_files: utf8OrderedPaths,
      affected_files: utf8OrderedPaths,
    })).toMatchObject({ changed_files: utf8OrderedPaths, affected_files: utf8OrderedPaths });
    expect(() => validateRustSyntaxWorkerMessage({ ...result, changed_files: ["src/index.ts", "src/dependency.ts"] })).toThrow(/sorted/iu);
    expect(() => validateRustSyntaxWorkerMessage({ ...result, reset_reason: "invented" })).toThrow(/reset reason/iu);
    expect(() => validateRustSyntaxWorkerMessage({ ...page, byte_length: -1 })).toThrow(/byte_length/iu);
    expect(() => validateRustSyntaxWorkerMessage({ ...page, records: [{ ...page.records[0], facets: '["not canonical", ]' }] })).toThrow(/canonical JSON/iu);
    expect(() => validateRustSyntaxWorkerMessage({ ...page, direct_imports: [{ ...page.direct_imports[0], end: -1 }] })).toThrow(/import span/iu);
    expect(() => validateRustSyntaxWorkerMessage({
      ...page,
      diagnostics: [{ message: "bad", start: 2, end: 1 }],
    })).toThrow(/diagnostic span/iu);
    expect(() => validateRustSyntaxWorkerMessage({ ...result, metrics: { ...result.metrics, bytes_retained: -1 } })).toThrow(/boundary metric/iu);
  });

  it("rejects ambiguous source sets and budgets before a worker is contacted", () => {
    const source = { path: "src/index.ts", artifact_id: "artifact:index", artifact_version_id: "version:index", content_digest: SHA256, source_blob_path: resolve(".urdira-test-source"), byte_length: 23 };
    const dependency = { ...source, path: "src/dependency.ts", artifact_id: "artifact:dependency", artifact_version_id: "version:dependency", source_blob_path: resolve(".urdira-test-dependency") };
    const input = {
      request_id: "request:validation",
      cancellation_id: "cancel:validation",
      project_key: "project:one",
      configuration_digest: SHA256,
      root_names: [source.path],
      files: [source],
      max_output_bytes: 1024,
      max_files: 1,
      max_source_bytes: 1024,
    };
    const exact = createRustSyntaxAnalyzeRequest({
      ...input,
      files: [source, dependency],
      root_names: [source.path, dependency.path],
      changed_artifact_ids: [source.artifact_id],
      max_files: 2,
    });
    expect(exact.files.map((file) => file.path)).toEqual(["src/dependency.ts", "src/index.ts"]);
    expect(exact.change_set).toEqual({ kind: "exact", changed_artifact_ids: ["artifact:index"] });
    expect(createRustSyntaxAnalyzeRequest(input).change_set).toEqual({ kind: "full" });
    expect(createRustSyntaxAnalyzeRequest({ ...input, changed_artifact_ids: [] }).change_set).toEqual({ kind: "exact", changed_artifact_ids: [] });
    const utf8Paths = ["é.ts", "a.ts", "_a.ts", "A.ts", "[a].ts", "z.ts"];
    expect(createRustSyntaxAnalyzeRequest({
      ...input,
      files: utf8Paths.map((path) => ({ ...source, path, artifact_id: `artifact:${path}`, artifact_version_id: `version:${path}`, source_blob_path: resolve(`.${path}.blob`) })),
      root_names: utf8Paths,
      max_files: utf8Paths.length,
    }).files.map((file) => file.path)).toEqual(["A.ts", "[a].ts", "_a.ts", "a.ts", "z.ts", "é.ts"]);
    expect(() => createRustSyntaxAnalyzeRequest({ ...input, files: [source, source], max_files: 2 })).toThrow(/duplicate source/iu);
    expect(() => createRustSyntaxAnalyzeRequest({ ...input, files: [{ ...source, path: "../outside.ts" }] })).toThrow(/normalized and relative/iu);
    expect(() => createRustSyntaxAnalyzeRequest({ ...input, files: [{ ...source, source_blob_path: "relative.blob" }] })).toThrow(/blob path/iu);
    expect(() => createRustSyntaxAnalyzeRequest({ ...input, max_source_bytes: 22 })).toThrow(/declared budget/iu);
    expect(() => createRustSyntaxAnalyzeRequest({ ...input, root_names: ["src/missing.ts"] })).toThrow(/members of files/iu);
    expect(() => createRustSyntaxAnalyzeRequest({ ...input, changed_artifact_ids: [source.artifact_id, source.artifact_id] })).toThrow(/changed_artifact_ids.*duplicate/iu);
    expect(() => createRustSyntaxAnalyzeRequest({ ...input, files: [source, { ...dependency, artifact_id: source.artifact_id }], root_names: [source.path, dependency.path], max_files: 2 })).toThrow(/duplicate source artifact_id/iu);
    expect(() => createRustSyntaxAnalyzeRequest({ ...input, max_output_bytes: 0 })).toThrow(/positive integer/iu);
  });
});
