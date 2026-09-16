import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ProposedRecord, ProposedRecordDependency } from "@urdira/contracts";
import {
  JSTS_RUST_SYNTAX_BUILD_IDENTITY,
  analyzeBoundedSyntaxProject,
  createJavascriptTypescriptProcessTransport,
  createRustSyntaxAnalyzeRequest,
} from "../packages/plugin-javascript-typescript/src/index.js";

const executable = process.env["URDIRA_JSTS_RUST_WORKER"];

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function source(path: string, text: string) {
  const bytes = new TextEncoder().encode(text);
  const directory = await mkdtemp(join(tmpdir(), "urdira-rust-source-"));
  temporaryDirectories.push(directory);
  const sourceBlobPath = join(directory, "source.blob");
  await writeFile(sourceBlobPath, bytes);
  const contentDigest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  return { path, artifact_id: `artifact:${path}`, artifact_version_id: `version:${path}:${contentDigest.slice(-12)}`, source_blob_path: sourceBlobPath, byte_length: bytes.byteLength, content_digest: contentDigest };
}

async function readOwner(transport: ReturnType<typeof createJavascriptTypescriptProcessTransport>, projectKey: string, path: string, cancellationId: string) {
  const records: ProposedRecord[] = [];
  const dependencies: ProposedRecordDependency[] = [];
  const directImports: { readonly specifier: string; readonly target_path?: string; readonly kind: "import" | "export" | "dynamic_import" | "require"; readonly start: number; readonly end: number }[] = [];
  let cursor: { readonly imports_offset: number; readonly records_offset: number; readonly dependencies_offset: number } | undefined;
  do {
    const page = await transport.readFacts({ project_key: projectKey, path, ...(cursor === undefined ? {} : { cursor }), max_output_bytes: 4 * 1024 * 1024, max_rows: 4096, cancellation_id: cancellationId });
    records.push(...page.records);
    dependencies.push(...page.dependencies);
    directImports.push(...page.direct_imports);
    cursor = page.next_cursor;
  } while (cursor !== undefined);
  return { records, dependencies, direct_imports: directImports };
}

describe("JavaScript/TypeScript persistent Rust syntax worker", () => {
  it.skipIf(executable === undefined)("matches the legacy stage-one visible entities and relations without running it in production", async () => {
    const transport = createJavascriptTypescriptProcessTransport({ command: executable!, expected_build_identity: JSTS_RUST_SYNTAX_BUILD_IDENTITY });
    const texts = new Map([
      ["a.ts", "const greeting = '😀';\nexport function run() {}\nexport { value } from './b';"],
      ["b.ts", "export interface Shape {}\nexport type Name = string;\nexport const value = 1;"],
    ]);
    const files = await Promise.all([...texts].map(([path, text]) => source(path, text)));
    const projectKey = "project:differential";
    try {
      const result = await transport.analyze(createRustSyntaxAnalyzeRequest({
        request_id: "analyze:differential",
        cancellation_id: "cancel:differential",
        project_key: projectKey,
        configuration_digest: `sha256:${"2".repeat(64)}`,
        root_names: files.map((file) => file.path),
        files,
        max_output_bytes: 1024 * 1024,
        max_files: 8,
        max_source_bytes: 1024 * 1024,
      }));
      const legacy = analyzeBoundedSyntaxProject({ files: [...texts].map(([path, text]) => ({ path, text })) });
      const grouped = await transport.readFactsGroup({
        project_key: projectKey,
        entries: result.affected_files.map((path) => ({ path })),
        max_output_bytes: 16 * 1024 * 1024,
        max_rows: 4096,
        cancellation_id: "cancel:facts:differential:group",
      });
      expect(grouped.pages.map((page) => page.path)).toEqual(result.affected_files);
      expect(grouped.pages.every((page) => page.next_cursor === undefined)).toBe(true);
      for (const path of result.affected_files) {
        const page = await readOwner(transport, projectKey, path, `cancel:facts:differential:${path}`);
        const recordIdentities = page.records.map((record) => record.identity_key);
        expect(recordIdentities.filter((identity) => identity.startsWith("jsts:") && !identity.startsWith("jsts:contains") && !identity.startsWith("jsts:import") && !identity.startsWith("jsts:export")))
          .toEqual(legacy.entities.filter((entity) => entity.path === path).map((entity) => entity.id));
        // Entity identities stay anchored to the declaration name. Relation
        // identities may legitimately move when Rust widens a declaration
        // span (the v4 full-declaration-span contract), so compare the
        // stable graph endpoints and relation kind instead of byte offsets.
        const rustRelations = page.records
          .filter((record) => record.category === "relation")
          .map((record) => {
            const body = record.body as { readonly source_id?: string; readonly target_id?: string };
            const kind = record.kind === "jsts:relation_contains" ? "core:contains" : record.kind === "jsts:relation_export" ? "core:export" : record.kind === "jsts:relation_import" ? "core:import" : record.kind;
            const transportRecord = record as ProposedRecord & { source_id?: string | null; target_id?: string | null };
            return { kind, source_id: transportRecord.source_id ?? body.source_id ?? null, target_id: transportRecord.target_id ?? body.target_id ?? null };
          })
          .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
        const legacyRelations = legacy.relations
          .filter((relation) => relation.path === path)
          .map((relation) => ({ kind: relation.kind, source_id: relation.source_id, target_id: relation.target_id ?? null }))
          .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
        expect(rustRelations).toEqual(legacyRelations);
      }
      await transport.commitAnalysis({ project_key: projectKey, analysis_token: result.analysis_token });
    } finally {
      await transport.terminate();
    }
  });

  it.skipIf(executable === undefined)("keeps project state and returns the reverse affected closure over the real process protocol", async () => {
    const transport = createJavascriptTypescriptProcessTransport({
      command: executable!,
      expected_build_identity: JSTS_RUST_SYNTAX_BUILD_IDENTITY,
    });
    const files = await Promise.all([
      source("a.ts", "import { b } from './b'; export const a = b;"),
      source("b.ts", "import { c } from './c'; export const b = c;"),
      source("c.ts", "export const c = 1;"),
      source("view.tsx", "export const View = () => <div />;"),
    ]);
    const base = {
      project_key: "project:process",
      configuration_digest: `sha256:${"1".repeat(64)}`,
      root_names: files.map((file) => file.path),
      max_output_bytes: 1024 * 1024,
      max_files: 16,
      max_source_bytes: 1024 * 1024,
    } as const;
    try {
      await transport.ready();
      const first = await transport.analyze(createRustSyntaxAnalyzeRequest({
        ...base, request_id: "analyze:one", cancellation_id: "cancel:one", files,
      }));
      expect(first.build).toBe("full");
      const a = await readOwner(transport, base.project_key, "a.ts", "cancel:facts:one:a");
      expect(a.direct_imports[0]?.target_path).toBe("b.ts");
      expect(a.records.filter((record) => record.category === "entity").map((record) => [(record.body as { kind: string }).kind, (record.body as { name: string }).name])).toEqual([
        ["module", "a.ts"],
        ["variable", "a"],
      ]);
      expect(a.records.filter((record) => record.category === "relation").map((record) => record.universal_kind).sort()).toEqual(["core:contains", "core:import"]);
      await transport.commitAnalysis({ project_key: base.project_key, analysis_token: first.analysis_token });

      const changed = await source("c.ts", "export const c = 2;");
      const edited = files.map((file) => file.path === "c.ts" ? changed : file);
      const second = await transport.analyze(createRustSyntaxAnalyzeRequest({
        ...base,
        request_id: "analyze:two",
        cancellation_id: "cancel:two",
        files: edited,
        changed_artifact_ids: [changed.artifact_id],
      }));
      expect(second.build).toBe("incremental");
      expect(second.changed_files).toEqual(["c.ts"]);
      expect(second.affected_files).toEqual(["a.ts", "b.ts", "c.ts"]);
      for (const path of second.affected_files) await readOwner(transport, base.project_key, path, `cancel:facts:two:${path}`);
      await transport.commitAnalysis({ project_key: base.project_key, analysis_token: second.analysis_token });
      expect(await transport.reset(base.project_key)).toBe(1);
      await transport.shutdown();
    } finally {
      await transport.terminate();
    }
  });
});
