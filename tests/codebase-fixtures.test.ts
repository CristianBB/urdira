import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  capabilityRegistry,
  operationDefinitions,
  semanticRoleRegistry,
  universalEntityKinds,
  universalRelationKinds,
} from "@urdira/contracts";

const testRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const fixtureRoot = join(testRoot, "tests", "fixtures", "codebases");
const languageDirectories = ["typescript", "javascript", "rust"] as const;

type SourceAnchor = { readonly path: string; readonly anchor: string };
type Subject = { readonly id: string; readonly universal_kind: string; readonly source: SourceAnchor };
type Relation = {
  readonly id: string;
  readonly universal_kind: string;
  readonly participants: readonly { readonly role: string; readonly subject_id: string }[];
  readonly evidence: { readonly classification: "confirmed" | "possible"; readonly source: SourceAnchor };
};
type Manifest = {
  readonly schema_version: number;
  readonly fixture: { readonly id: string; readonly language: string; readonly project_root: string };
  readonly artifacts: readonly string[];
  readonly subjects: readonly Subject[];
  readonly relations: readonly Relation[];
  readonly operation_cases: readonly {
    readonly id: string;
    readonly operation_id: string;
    readonly arguments: Readonly<Record<string, unknown>>;
    readonly required_capabilities: readonly string[];
    readonly expected: {
      readonly streams: Readonly<Record<string, { readonly confirmed: readonly string[]; readonly possible: readonly string[] }>>;
      readonly completeness: "complete" | "incomplete" | "unsupported";
    };
  }[];
};

async function readManifest(language: string): Promise<{ manifest: Manifest; projectRoot: string }> {
  const manifestName = language === "rust" ? "library-lending" : "task-planner";
  const manifestPath = join(fixtureRoot, language, `${manifestName}.gold.json`);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Manifest;
  const projectRoot = resolve(fixtureRoot, manifest.fixture.project_root);
  return { manifest, projectRoot };
}

function unique(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

function assertSafeRelativePath(value: string): void {
  expect(value.length).toBeGreaterThan(0);
  expect(value).not.toMatch(/^([/\\]|[A-Za-z]:)/u);
  expect(value.split(/[\\/]/u)).not.toContain("..");
}

async function assertAnchor(projectRoot: string, source: SourceAnchor): Promise<void> {
  assertSafeRelativePath(source.path);
  const path = resolve(projectRoot, source.path);
  expect(relative(projectRoot, path).startsWith(`..${sep}`)).toBe(false);
  const contents = await readFile(path, "utf8");
  expect(contents.split(source.anchor).length - 1).toBe(1);
}

describe("E2E codebase gold manifests", () => {
  for (const language of languageDirectories) {
    it(`keeps the ${language} fixture executable and its gold manifest closed`, async () => {
      const { manifest, projectRoot } = await readManifest(language);
      expect(manifest.schema_version).toBe(1);
      expect(manifest.fixture.language).toBe(language);
      expect(unique(manifest.artifacts)).toBe(true);
      expect(unique(manifest.subjects.map((subject) => subject.id))).toBe(true);
      expect(unique(manifest.relations.map((relation) => relation.id))).toBe(true);
      expect(unique(manifest.operation_cases.map((operation) => operation.id))).toBe(true);

      const subjectIds = new Set(manifest.subjects.map((subject) => subject.id));
      const relationIds = new Set(manifest.relations.map((relation) => relation.id));
      const artifactPaths = new Set<string>();
      for (const artifact of manifest.artifacts) {
        assertSafeRelativePath(artifact);
        const artifactPath = resolve(projectRoot, artifact);
        expect(relative(projectRoot, artifactPath).startsWith(`..${sep}`)).toBe(false);
        await expect(stat(artifactPath)).resolves.toBeDefined();
        artifactPaths.add(artifact);
      }
      expect(artifactPaths.size).toBe(manifest.artifacts.length);

      for (const subject of manifest.subjects) {
        expect(universalEntityKinds).toContain(subject.universal_kind);
        for (const role of ((subject as Subject & { readonly semantic_roles?: readonly string[] }).semantic_roles ?? [])) expect(semanticRoleRegistry).toContain(role);
        expect(manifest.artifacts).toContain(subject.source.path);
        await assertAnchor(projectRoot, subject.source);
      }
      for (const relation of manifest.relations) {
        expect(universalRelationKinds).toContain(relation.universal_kind);
        expect(unique(relation.participants.map((participant) => participant.role))).toBe(true);
        for (const participant of relation.participants) expect(subjectIds).toContain(participant.subject_id);
        expect(manifest.artifacts).toContain(relation.evidence.source.path);
        await assertAnchor(projectRoot, relation.evidence.source);
      }
      for (const operationCase of manifest.operation_cases) {
        const operation = operationDefinitions.find((candidate) => candidate.operation_id === operationCase.operation_id);
        expect(operation).toBeDefined();
        expect(operationCase.arguments).toBeTypeOf("object");
        for (const capability of operationCase.required_capabilities) expect(capabilityRegistry).toContain(capability);
        for (const [stream, expected] of Object.entries(operationCase.expected.streams)) {
          const streamDefinition = operation?.result_stream_definitions.find((candidate) => candidate.stream_name === stream);
          expect(streamDefinition).toBeDefined();
          expect(unique(expected.confirmed)).toBe(true);
          expect(unique(expected.possible)).toBe(true);
          for (const subjectId of [...expected.confirmed, ...expected.possible]) {
            expect(subjectIds.has(subjectId) || relationIds.has(subjectId)).toBe(true);
          }
          if (expected.confirmed.length > 0) expect(streamDefinition?.classifications).toContain("confirmed");
          if (expected.possible.length > 0) expect(streamDefinition?.classifications).toContain("possible");
        }
      }
    });
  }
});
