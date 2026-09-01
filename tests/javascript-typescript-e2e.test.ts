import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { ProposedRecord } from "@urdira/contracts";
import {
  JSTS_RUST_SYNTAX_BUILD_IDENTITY,
  analyzeProject,
  createJavascriptTypescriptProcessTransport,
  createJavascriptTypescriptWorker,
  createRustSyntaxAnalyzeRequest,
  discoverProjects,
  type AnalyzerFile,
} from "../packages/plugin-javascript-typescript/src/index.js";

const run = promisify(execFile);
const fixtureRoot = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures", "codebases", "javascript", "task-planner");
const manifestPath = resolve(fixtureRoot, "..", "task-planner.gold.json");

type GoldManifest = {
  readonly artifacts: readonly string[];
  readonly subjects: readonly { readonly name: string; readonly source: { readonly path: string } }[];
};

async function fixtureInput(): Promise<{ readonly manifest: GoldManifest; readonly files: readonly AnalyzerFile[] }> {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as GoldManifest;
  const files = await Promise.all(manifest.artifacts.map(async (path) => ({ path, text: await readFile(join(fixtureRoot, path), "utf8") })));
  return { manifest, files };
}

function request(call: "discover_partitions" | "analyze_artifact" | "generate_projection", files: readonly AnalyzerFile[]) {
  return {
    protocol_version: "1.0.0",
    request_id: `javascript-e2e:${call}`,
    request_digest: `digest:${call}`,
    call,
    deadline: "2030-01-01T00:00:00.000Z",
    cancellation_id: `cancel:${call}`,
    payload: { files },
  } as const;
}

describe("JavaScript/TypeScript production-plugin E2E", () => {
  it("executes the JavaScript fixture and discovers its jsconfig project", async () => {
    const { files } = await fixtureInput();
    const result = await run(process.execPath, ["--test", "test/task-service.spec.js"], { cwd: fixtureRoot });
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("tests 3");
    const partitions = discoverProjects(files);
    expect(partitions).toHaveLength(1);
    expect(partitions[0]).toMatchObject({ config_path: "jsconfig.json", inferred: false });
    expect(partitions[0]?.root_names).toContain("src/services/task-service.js");
  });

  it("indexes the JavaScript gold-manifest symbols, calls, and projections through all worker calls", async () => {
    const { manifest, files } = await fixtureInput();
    const worker = createJavascriptTypescriptWorker();
    const discovered = await worker.invoke(request("discover_partitions", files));
    expect(discovered).toMatchObject({ outcome: "success", payload: { partitions: [{ config_path: "jsconfig.json" }] } });

    const analysis = analyzeProject({ files, root_names: files.map((file) => file.path) });
    const entityNames = new Set(analysis.entities.map((entity) => entity.name));
    for (const subject of manifest.subjects) {
      if (subject.name.includes("entry module") || subject.name.includes("tests")) continue;
      expect(entityNames, `${subject.name} from ${subject.source.path}`).toContain(subject.name);
    }
    expect(analysis.relations.some((relation) => relation.kind === "core:call" && relation.classification === "confirmed")).toBe(true);
    expect(analysis.relations.some((relation) => relation.kind === "core:call" && relation.classification === "possible")).toBe(true);

    const firstProjection = await worker.invoke(request("generate_projection", files));
    const secondProjection = await worker.invoke(request("generate_projection", files));
    expect(firstProjection).toEqual(secondProjection);
    expect((firstProjection as { readonly payload: { readonly projection_set: { readonly projections: readonly unknown[] } } }).payload.projection_set.projections.length).toBeGreaterThan(0);
    await worker.terminate();
  });

  it("emits the core-facing FactDelta envelope for an artifact work item", async () => {
    const { files } = await fixtureInput();
    const worker = createJavascriptTypescriptWorker();
    const sourceFiles = files.filter((file) => file.path === "src/services/task-service.js");
    const result = await worker.invoke({
      ...request("analyze_artifact", sourceFiles),
      payload: {
        files: sourceFiles,
        work_item: {
          candidate_generation_id: "candidate:javascript-e2e",
          workspace_id: "workspace:javascript-e2e",
          artifact_id: "artifact:task-service",
          target_artifact_version_id: "version:task-service",
          work_item_id: "work:task-service",
          plugin_id: "urdira:javascript_typescript",
          plugin_version: "0.2.0",
          base_snapshot_id: "snapshot:javascript-e2e",
          expected_replacement_scopes: [{ replacement_scope_id: "scope:task-service", owner_artifact_id: "artifact:task-service", owner_artifact_version_id: "version:task-service", capability: "core:symbol_declarations", record_categories: ["entity"], record_kinds: ["jsts:entity_type", "jsts:entity_callable", "jsts:entity_variable"], base_record_set_digest: "sha256:empty", output_completeness: "complete" }],
        },
        accepted_manifest: {
          plugin_input_access_manifest_id: "manifest:javascript-e2e",
          manifest_digest: "sha256:javascript-e2e-manifest",
          artifact_version_entries: [{ artifact_version_id: "version:task-service" }],
          record_entries: [],
        },
      },
    });
    const payload = (result as { readonly payload: { readonly result_type: string; readonly validation_input: { readonly raw_delta: { readonly owner_artifact_id: string; readonly proposed_records: readonly unknown[] } } } }).payload;
    expect(payload.result_type).toBe("fact_delta");
    expect(payload.validation_input.raw_delta.owner_artifact_id).toBe("artifact:task-service");
    expect(payload.validation_input.raw_delta.proposed_records.length).toBeGreaterThan(0);
    await worker.terminate();
  });
});

// ---------------------------------------------------------------------------
// E0: entity identity unification between the Rust syntax worker and the
// TypeScript checker (docs/evidence/2026-09-01-f5-hybrid-design.md, Hallazgo
// A). Both producers now key an entity's identity on the START OF THE NAME
// IDENTIFIER (`identifier.span.start` in Rust, the equivalent name-node start
// in analyzer.ts) instead of the declaration's own start -- this is what lets
// a future merge point treat "the same declaration produced by either
// producer" as literally the same record id.
// ---------------------------------------------------------------------------

const rustWorkerExecutable = process.env["URDIRA_JSTS_RUST_WORKER"];
const identityTemporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(identityTemporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function identitySourceInput(path: string, text: string) {
  const bytes = new TextEncoder().encode(text);
  const directory = await mkdtemp(join(tmpdir(), "urdira-identity-source-"));
  identityTemporaryDirectories.push(directory);
  const sourceBlobPath = join(directory, "source.blob");
  await writeFile(sourceBlobPath, bytes);
  const contentDigest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  return { path, artifact_id: `artifact:${path}`, artifact_version_id: `version:${path}:${contentDigest.slice(-12)}`, source_blob_path: sourceBlobPath, byte_length: bytes.byteLength, content_digest: contentDigest };
}

async function readAllOwnerFacts(transport: ReturnType<typeof createJavascriptTypescriptProcessTransport>, projectKey: string, path: string, cancellationId: string): Promise<readonly ProposedRecord[]> {
  const records: ProposedRecord[] = [];
  let cursor: { readonly imports_offset: number; readonly records_offset: number; readonly dependencies_offset: number } | undefined;
  do {
    const page = await transport.readFacts({ project_key: projectKey, path, ...(cursor === undefined ? {} : { cursor }), max_output_bytes: 4 * 1024 * 1024, max_rows: 4096, cancellation_id: cancellationId });
    records.push(...page.records);
    cursor = page.next_cursor;
  } while (cursor !== undefined);
  return records;
}

// Deliberately exercises every declaration shape the task called out:
// function/class/interface/enum/variable/method/parameter, an ambient
// (`declare`) ombination, a named `export default`, a TS 5 class decorator,
// a TS parameter-property (modifiers preceding a parameter's name), and an
// emoji + accented-letter preamble that makes UTF-8-byte and UTF-16-code-unit
// offsets diverge ahead of the `niño` declaration -- if either producer's
// offset arithmetic (Rust's `Utf8ToUtf16`, lib.rs:1689) were wrong, that
// divergence would show up as a mismatched identity_key below.
const IDENTITY_FIXTURE_PATH = "identity.ts";
const IDENTITY_FIXTURE_TEXT = [
  "function sealed(_target: unknown) { return _target; }",
  "",
  'const banner = "\u{1F600} café niño — helló wörld";',
  "",
  "export function niño(): string {",
  '  return "café";',
  "}",
  "",
  "@sealed",
  "export class Widget {",
  "  private readonly label: string;",
  "  constructor(private readonly owner: string) {",
  "    this.label = owner;",
  "  }",
  "  public async render(size: number): Promise<string> {",
  '    return this.label + ":" + size;',
  "  }",
  "  public get area(): number {",
  "    return 0;",
  "  }",
  "  public set area(value: number) {}",
  "}",
  "",
  "export interface Shape {",
  "  area(): number;",
  "}",
  "",
  "export enum Color {",
  "  Red,",
  "  Green,",
  "}",
  "",
  "export type Alias = string;",
  "",
  "export const single = 1;",
  "",
  "export default function named(): void {}",
  "",
].join("\n");

// Kinds `EntityKind` (crates/urdira-jsts-syntax-worker/src/lib.rs) also
// produces today -- these must match the checker's id byte-for-byte.
const RUST_OVERLAPPING_DECLARATIONS: ReadonlyArray<readonly [kind: string, name: string]> = [
  ["function", "sealed"],
  ["variable", "banner"],
  ["function", "niño"],
  ["class", "Widget"],
  ["interface", "Shape"],
  ["enum", "Color"],
  ["type", "Alias"],
  ["variable", "single"],
  ["function", "named"],
];

// Checker-only kinds (Rust has no `EntityKind` for these yet -- member-level
// declarations remain the checker's job, Hallazgo B). Each is chosen so a
// modifier/keyword precedes the name, meaning the declaration's own start and
// the name identifier's start are DIFFERENT positions -- a real regression
// check, not a vacuous one.
const CHECKER_ONLY_MODIFIED_DECLARATIONS: ReadonlyArray<readonly [kind: string, name: string]> = [
  ["property", "label"],
  ["parameter", "owner"],
  ["method", "render"],
  ["getter", "area"],
  ["setter", "area"],
];

describe("JavaScript/TypeScript E0 entity identity unification (Rust syntax worker vs. checker)", () => {
  it.skipIf(rustWorkerExecutable === undefined)("keys checker entity ids on the same name-identifier start the Rust syntax worker uses", async () => {
    const files: readonly AnalyzerFile[] = [{ path: IDENTITY_FIXTURE_PATH, text: IDENTITY_FIXTURE_TEXT }];

    // 1. The checker path (analyzer.ts, the code this task fixes).
    const checkerAnalysis = analyzeProject({ files, root_names: files.map((file) => file.path) });
    const checkerIdByKey = new Map<string, string>(checkerAnalysis.entities.map((entity) => [`${entity.kind}:${entity.name}`, entity.id]));

    // 2. The real Rust syntax worker, over the identical source text.
    const transport = createJavascriptTypescriptProcessTransport({ command: rustWorkerExecutable!, expected_build_identity: JSTS_RUST_SYNTAX_BUILD_IDENTITY });
    const projectKey = "project:e0-identity";
    try {
      const rustFile = await identitySourceInput(IDENTITY_FIXTURE_PATH, IDENTITY_FIXTURE_TEXT);
      const analyzeResult = await transport.analyze(createRustSyntaxAnalyzeRequest({
        request_id: "analyze:e0-identity",
        cancellation_id: "cancel:e0-identity",
        project_key: projectKey,
        configuration_digest: `sha256:${"3".repeat(64)}`,
        root_names: [IDENTITY_FIXTURE_PATH],
        files: [rustFile],
        max_output_bytes: 1024 * 1024,
        max_files: 8,
        max_source_bytes: 1024 * 1024,
      }));
      const rustRecords = await readAllOwnerFacts(transport, projectKey, IDENTITY_FIXTURE_PATH, "cancel:facts:e0-identity");
      expect(analyzeResult.affected_files).toEqual([IDENTITY_FIXTURE_PATH]);
      const rustEntityIdByKey = new Map<string, string>(
        rustRecords
          .filter((record) => record.category === "entity")
          .map((record) => [`${(record.body as { readonly kind: string }).kind}:${(record.body as { readonly name: string }).name}`, record.identity_key]),
      );

      // Every declaration Rust and the checker BOTH model must resolve to the
      // exact same identity_key -- this is the core E0 assertion.
      expect(RUST_OVERLAPPING_DECLARATIONS.length).toBeGreaterThan(0);
      for (const [kind, name] of RUST_OVERLAPPING_DECLARATIONS) {
        const key = `${kind}:${name}`;
        const rustId = rustEntityIdByKey.get(key);
        const checkerId = checkerIdByKey.get(key);
        expect(rustId, `Rust did not emit ${key}`).toBeDefined();
        expect(checkerId, `checker did not emit ${key}`).toBeDefined();
        expect(checkerId, `${key} identity_key mismatch between checker and Rust`).toBe(rustId);
      }
      // No coverage drift: Rust models exactly this many entities in the
      // overlapping kind set (module aside), and the checker must not have
      // silently dropped or duplicated any of them.
      const rustOverlappingCount = [...rustEntityIdByKey.keys()].filter((key) => key !== `module:${IDENTITY_FIXTURE_PATH}`).length;
      expect(rustOverlappingCount).toBe(RUST_OVERLAPPING_DECLARATIONS.length);

      await transport.commitAnalysis({ project_key: projectKey, analysis_token: analyzeResult.analysis_token });
    } finally {
      await transport.terminate();
    }

    // 3. Checker-only member declarations: Rust has no counterpart to diff
    // against, so assert directly against the source text that the id's
    // offset lands exactly on the name identifier -- not on a preceding
    // modifier/keyword, which is what the pre-E0 `node.getStart()` convention
    // would have produced for every one of these.
    for (const [kind, name] of CHECKER_ONLY_MODIFIED_DECLARATIONS) {
      const id = checkerIdByKey.get(`${kind}:${name}`);
      expect(id, `checker did not emit ${kind}:${name}`).toBeDefined();
      const match = /^jsts:[a-z]+:[^:]+:(\d+):[^:]+$/.exec(id!);
      expect(match, `unexpected id shape for ${kind}:${name}: ${id}`).not.toBeNull();
      const offset = Number(match![1]);
      expect(IDENTITY_FIXTURE_TEXT.slice(offset, offset + name.length), `${kind}:${name} id offset ${offset} does not point at the name identifier`).toBe(name);
    }
  });
});
