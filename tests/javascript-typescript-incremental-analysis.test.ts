import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  analyzeProject,
  JsTsAnalysisSession,
  type AnalyzerFile,
  type JsTsAnalysisResult,
} from "../packages/plugin-javascript-typescript/src/index.js";

// Load-bearing invariant (see docs/incremental-analyze-spec.md): a
// `JsTsAnalysisSession`'s incremental result must canonical-JSON deep-equal
// a fresh `analyzeProject` call over the identical inputs -- same arrays,
// same order, same `type` strings, same diagnostics, same closures, same
// flags. Every test below either asserts this directly (`toEqual`, vitest's
// deep-equality, which is order-sensitive for arrays exactly like JSON
// equality) or asserts the fallback-to-full-rebuild rules that make the
// incremental path inapplicable in the first place.

const here = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = resolve(here, "fixtures", "codebases", "typescript", "task-planner");
const manifestPath = resolve(fixtureRoot, "..", "task-planner.gold.json");

type GoldManifest = { readonly artifacts: readonly string[] };

async function fixtureFiles(): Promise<AnalyzerFile[]> {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as GoldManifest;
  const files = await Promise.all(manifest.artifacts.map(async (path): Promise<AnalyzerFile> => ({ path, text: await readFile(join(fixtureRoot, path), "utf8") })));
  return files.filter((file) => file.path.endsWith(".ts"));
}

function withFile(files: readonly AnalyzerFile[], path: string, text: string): AnalyzerFile[] {
  return files.map((file) => (file.path === path ? { ...file, text } : file));
}

function fileText(files: readonly AnalyzerFile[], path: string): string {
  const file = files.find((candidate) => candidate.path === path);
  if (file === undefined) throw new Error(`fixture is missing ${path}`);
  return file.text;
}

describe("JsTsAnalysisSession incremental analysis: differential correctness", () => {
  it("matches a fresh analyzeProject across a realistic sequence of edits (leaf, barrel, widely-imported type, compiler error, test file)", async () => {
    const base = await fixtureFiles();
    expect(base.length).toBeGreaterThan(5);
    const session = new JsTsAnalysisSession();

    // 1. First call: no prior state -> full build, must match a fresh analyzeProject.
    const first = session.analyze({ files: base });
    expect(first.build).toBe("full");
    expect(first.result).toEqual(analyzeProject({ files: base }));

    // 2. Edit a widely-imported leaf's exported TYPE (`TaskStatus`): every
    // dependent (`task-repository.ts`, `in-memory-task-repository.ts`,
    // `task-service.ts`) has this file in its dependency closure, so all of
    // them must be re-walked and their `type` strings (and any diagnostics)
    // must reflect the new union.
    const step2 = withFile(base, "src/domain/task.ts", fileText(base, "src/domain/task.ts").replace(
      `export type TaskStatus = "todo" | "in_progress" | "done";`,
      `export type TaskStatus = "todo" | "in_progress" | "done" | "archived";`,
    ));
    const r2 = session.analyze({ files: step2 });
    expect(r2.build).toBe("incremental");
    expect(r2.rewalked).toContain("src/domain/task.ts");
    expect(r2.result).toEqual(analyzeProject({ files: step2 }));

    // 3. Edit the re-export barrel (`src/index.ts`): drop one re-export.
    // `src/main.ts` and `test/task-service.spec.ts` both import through the
    // barrel, so their own resolved targets/diagnostics can change too.
    const step3 = withFile(step2, "src/index.ts", fileText(step2, "src/index.ts").replace(
      `export { TaskService } from "./services/task-service.js";\n`,
      ``,
    ));
    const r3 = session.analyze({ files: step3 });
    expect(r3.build).toBe("incremental");
    expect(r3.rewalked).toContain("src/index.ts");
    expect(r3.result).toEqual(analyzeProject({ files: step3 }));

    // 4. Introduce a compiler error: restore the barrel export (back to a
    // consistent state) but break `task-service.ts`'s own typing.
    const step4a = withFile(step3, "src/index.ts", fileText(base, "src/index.ts"));
    const step4 = withFile(step4a, "src/services/task-service.ts", fileText(step4a, "src/services/task-service.ts").replace(
      `public createTask(input: CreateTaskInput): Task {`,
      `public createTask(input: CreateTaskInput): number {`,
    ));
    const r4 = session.analyze({ files: step4 });
    expect(r4.build).toBe("incremental");
    const freshR4 = analyzeProject({ files: step4 });
    expect(r4.result).toEqual(freshR4);
    expect(freshR4.diagnostics.some((diagnostic) => diagnostic.code === "jsts:compiler_diagnostic" && diagnostic.path === "src/services/task-service.ts")).toBe(true);
    expect(freshR4.complete).toBe(false);

    // 5. Fix the compiler error: the diagnostic on `task-service.ts` must
    // disappear again (the fixture's own baseline `test/task-service.spec.ts`
    // diagnostics -- missing `@types/node` in this virtual environment --
    // are unrelated and persist), and the merged result must go back to
    // matching a fresh build exactly.
    const step5 = withFile(step4, "src/services/task-service.ts", fileText(base, "src/services/task-service.ts"));
    const r5 = session.analyze({ files: step5 });
    expect(r5.build).toBe("incremental");
    const freshR5 = analyzeProject({ files: step5 });
    expect(r5.result).toEqual(freshR5);
    expect(freshR5.diagnostics.some((diagnostic) => diagnostic.code === "jsts:compiler_diagnostic" && diagnostic.path === "src/services/task-service.ts")).toBe(false);

    // 6. Edit the test file itself: it `core:covers` `TaskService`/
    // `InMemoryTaskRepository` via its `core:references` relations: adding
    // another assertion referencing `TaskService` must not change the
    // covers set incorrectly, and must still match a fresh build exactly
    // (covers relations are never memoized -- always recomputed globally).
    const step6 = withFile(step5, "test/task-service.spec.ts", `${fileText(step5, "test/task-service.spec.ts")}\ntest("service is constructible again", () => {\n  const another = createService();\n  assert.ok(another instanceof TaskService);\n});\n`);
    const r6 = session.analyze({ files: step6 });
    expect(r6.build).toBe("incremental");
    const freshR6 = analyzeProject({ files: step6 });
    expect(r6.result).toEqual(freshR6);
    expect(freshR6.relations.some((relation) => relation.kind === "core:covers")).toBe(true);

    // 7. A genuine no-op re-submit (identical content): zero files re-walked,
    // still matches fresh.
    const r7 = session.analyze({ files: step6 });
    expect(r7.build).toBe("incremental");
    expect(r7.rewalked).toEqual([]);
    expect(r7.result).toEqual(freshR6);

    session.close();
  });

  it("re-walks only the files whose previous closure intersects the changed set (a completely unrelated leaf never triggers a wider re-walk)", async () => {
    const base = await fixtureFiles();
    const session = new JsTsAnalysisSession();
    session.analyze({ files: base });

    // `src/domain/errors.ts` is not imported by `src/domain/task.ts` or
    // `src/repository/task-repository.ts` -- editing it must not force
    // those files into the re-walk set.
    const edited = withFile(base, "src/domain/errors.ts", fileText(base, "src/domain/errors.ts").replace(`"TaskNotFoundError"`, `"TaskNotFoundErrorRenamed"`));
    const result = session.analyze({ files: edited });
    expect(result.build).toBe("incremental");
    expect(result.rewalked).not.toContain("src/domain/task.ts");
    expect(result.rewalked).not.toContain("src/repository/task-repository.ts");
    expect(result.result).toEqual(analyzeProject({ files: edited }));
    session.close();
  });

  it("seeds a session's memo from a loaded JsTsAnalysisResult (durable-cache-hit shape) and a subsequent edit still matches fresh", async () => {
    const base = await fixtureFiles();
    const freshAnalysis: JsTsAnalysisResult = analyzeProject({ files: base });

    const seeded = new JsTsAnalysisSession();
    seeded.seedFromAnalysis(freshAnalysis, base);

    const edited = withFile(base, "src/domain/task.ts", fileText(base, "src/domain/task.ts").replace(`readonly assignee?: string;`, `readonly assignee?: string;\n  readonly priority?: number;`));
    const result = seeded.analyze({ files: edited });
    // The API/program is built lazily on this first post-seed call, but the
    // WALK itself is still incremental (only files whose closure intersects
    // the edit get re-walked).
    expect(result.build).toBe("incremental");
    expect(result.result).toEqual(analyzeProject({ files: edited }));
    seeded.close();
  });

  it("falls back to a full rebuild on a root-set change (a file added), and the result is still correct", async () => {
    const base = await fixtureFiles();
    const session = new JsTsAnalysisSession();
    session.analyze({ files: base });

    const withNewFile: AnalyzerFile[] = [...base, { path: "src/domain/priority.ts", text: `export type Priority = "low" | "high";\n` }];
    const result = session.analyze({ files: withNewFile });
    expect(result.build).toBe("full");
    expect(result.result).toEqual(analyzeProject({ files: withNewFile }));
    session.close();
  });

  it("falls back to a full rebuild on a compiler_options change, and the result is still correct", async () => {
    const base = await fixtureFiles();
    const session = new JsTsAnalysisSession();
    session.analyze({ files: base });

    const result = session.analyze({ files: base, compiler_options: { strict: true } });
    expect(result.build).toBe("full");
    expect(result.result).toEqual(analyzeProject({ files: base, compiler_options: { strict: true } }));
    session.close();
  });

  it("falls back to a full rebuild when more than 40% of root files change content in one call", async () => {
    const files: AnalyzerFile[] = [
      { path: "a.ts", text: "export const a = 1;\n" },
      { path: "b.ts", text: "export const b = 2;\n" },
      { path: "c.ts", text: "export const c = 3;\n" },
    ];
    const session = new JsTsAnalysisSession();
    session.analyze({ files });

    // 2 of 3 files change (66% > 40%): must bail out to a full rebuild.
    const changed: AnalyzerFile[] = [
      { path: "a.ts", text: "export const a = 100;\n" },
      { path: "b.ts", text: "export const b = 200;\n" },
      { path: "c.ts", text: "export const c = 3;\n" },
    ];
    const result = session.analyze({ files: changed });
    expect(result.build).toBe("full");
    expect(result.result).toEqual(analyzeProject({ files: changed }));
    session.close();
  });

  it("stays under the bailout ratio and takes the incremental path for a small change on a small corpus", async () => {
    const files: AnalyzerFile[] = [
      { path: "a.ts", text: "export const a = 1;\n" },
      { path: "b.ts", text: "export const b = 2;\n" },
      { path: "c.ts", text: "export const c = 3;\n" },
    ];
    const session = new JsTsAnalysisSession();
    session.analyze({ files });

    // 1 of 3 files change (33% <= 40%): stays incremental.
    const changed: AnalyzerFile[] = [
      { path: "a.ts", text: "export const a = 100;\n" },
      { path: "b.ts", text: "export const b = 2;\n" },
      { path: "c.ts", text: "export const c = 3;\n" },
    ];
    const result = session.analyze({ files: changed });
    expect(result.build).toBe("incremental");
    expect(result.rewalked).toEqual(["a.ts"]);
    expect(result.result).toEqual(analyzeProject({ files: changed }));
    session.close();
  });

  it("re-walks a dependent file's compiler diagnostics when a dependency's exported shape changes underneath it (diagnostic appears, then disappears)", () => {
    // Two filler files keep the changed-file ratio under the 40% bailout
    // (1 of 4 = 25%) so this exercises the genuine incremental path rather
    // than tripping rule 2.
    const filesOk: AnalyzerFile[] = [
      { path: "widget.ts", text: "export interface Widget {\n  readonly name: string;\n}\n" },
      { path: "show.ts", text: "import type { Widget } from './widget';\nexport function show(widget: Widget): string {\n  return widget.name;\n}\n" },
      { path: "filler1.ts", text: "export const filler1 = 1;\n" },
      { path: "filler2.ts", text: "export const filler2 = 2;\n" },
    ];
    const session = new JsTsAnalysisSession();
    const okResult = session.analyze({ files: filesOk });
    expect(okResult.build).toBe("full");
    expect(okResult.result.diagnostics).toEqual([]);
    expect(okResult.result).toEqual(analyzeProject({ files: filesOk }));

    // Rename the property `show.ts` depends on: this is a content-only edit
    // to `widget.ts`, but `show.ts`'s own dependency closure includes
    // `widget.ts`, so `show.ts` must be re-walked and its NEW compiler
    // diagnostic must appear -- even though `show.ts`'s own text never changed.
    const filesBroken: AnalyzerFile[] = [
      { path: "widget.ts", text: "export interface Widget {\n  readonly label: string;\n}\n" },
      { path: "show.ts", text: filesOk[1]!.text },
      filesOk[2]!,
      filesOk[3]!,
    ];
    const brokenResult = session.analyze({ files: filesBroken });
    expect(brokenResult.build).toBe("incremental");
    expect(brokenResult.rewalked).toContain("show.ts");
    const freshBroken = analyzeProject({ files: filesBroken });
    expect(brokenResult.result).toEqual(freshBroken);
    expect(freshBroken.diagnostics.some((diagnostic) => diagnostic.path === "show.ts" && diagnostic.code === "jsts:compiler_diagnostic")).toBe(true);

    // Fix it: the diagnostic must disappear again, still with zero changes to `show.ts`'s own text.
    const fixedResult = session.analyze({ files: filesOk });
    expect(fixedResult.build).toBe("incremental");
    const freshFixed = analyzeProject({ files: filesOk });
    expect(fixedResult.result).toEqual(freshFixed);
    expect(freshFixed.diagnostics).toEqual([]);

    session.close();
  });

  it("measures incremental vs. full-rebuild wall time on the fixture corpus and reports it (informational, not a strict perf assertion)", async () => {
    const base = await fixtureFiles();
    const session = new JsTsAnalysisSession();
    const fullStart = performance.now();
    session.analyze({ files: base });
    const fullMs = performance.now() - fullStart;

    const edited = withFile(base, "src/domain/errors.ts", `${fileText(base, "src/domain/errors.ts")}\nexport class ExtraError extends Error {}\n`);
    const incrementalStart = performance.now();
    const incremental = session.analyze({ files: edited });
    const incrementalMs = performance.now() - incrementalStart;

    expect(incremental.build).toBe("incremental");
    expect(incremental.result).toEqual(analyzeProject({ files: edited }));
    console.log(`[incremental-analysis timing] full=${fullMs.toFixed(1)}ms incremental=${incrementalMs.toFixed(1)}ms rewalked=${incremental.rewalked.length}/${base.length}`);
    session.close();
  });
});

// Load-bearing invariant for this section (see docs/decisions -- the
// dependent-visible change gate): a hub file's edit only widens
// `rewalked`/`impactful_changed_paths` to its dependents when that edit
// could ACTUALLY change what a dependent sees (semantic tokens, guard
// comments, entity id/kind/path/start, or direct edges). A hub + two-
// importer fixture keeps each scenario below small and precise; every
// scenario still asserts the differential invariant (`result` deep-equals a
// fresh `analyzeProject`) alongside the gate-specific assertion.
describe("JsTsAnalysisSession incremental analysis: dependent-visible change gate", () => {
  function hubFixture(): AnalyzerFile[] {
    return [
      { path: "hub.ts", text: "export function helper(): number {\n  return 1;\n}\n" },
      { path: "a.ts", text: "import { helper } from './hub';\nexport const a = helper();\n" },
      { path: "b.ts", text: "import { helper } from './hub';\nexport const b = helper();\n" },
    ];
  }

  it("gates a comment-append hub edit: impactful is empty, and only the hub itself is rewalked", () => {
    const base = hubFixture();
    const session = new JsTsAnalysisSession();
    const first = session.analyze({ files: base });
    expect(first.build).toBe("full");

    const edited = withFile(base, "hub.ts", `${fileText(base, "hub.ts")}// probe\n`);
    const result = session.analyze({ files: edited });
    expect(result.build).toBe("incremental");
    expect(result.result).toEqual(analyzeProject({ files: edited }));
    expect(result.impactful_changed_paths).toEqual([]);
    expect(result.rewalked).toEqual(["hub.ts"]);
    session.close();
  });

  it("a hub's signature edit (exported function's return type) is impactful, and its dependents are rewalked", () => {
    const base = hubFixture();
    const session = new JsTsAnalysisSession();
    session.analyze({ files: base });

    const edited = withFile(base, "hub.ts", "export function helper(): string {\n  return \"1\";\n}\n");
    const result = session.analyze({ files: edited });
    expect(result.build).toBe("incremental");
    expect(result.result).toEqual(analyzeProject({ files: edited }));
    expect(result.impactful_changed_paths).toEqual(["hub.ts"]);
    expect(result.rewalked).toEqual(["a.ts", "b.ts", "hub.ts"]);
    session.close();
  });

  it("a mid-file comment insertion that shifts later entities' start offsets is impactful (correctness over speed)", () => {
    const base: AnalyzerFile[] = [
      { path: "hub.ts", text: "export function first(): number {\n  return 1;\n}\n\nexport function second(): number {\n  return 2;\n}\n" },
      { path: "a.ts", text: "import { first, second } from './hub';\nexport const sum = first() + second();\n" },
      { path: "filler1.ts", text: "export const filler1 = 1;\n" },
    ];
    const session = new JsTsAnalysisSession();
    session.analyze({ files: base });

    // A plain comment inserted BEFORE `second` shifts `second`'s (and
    // everything after it) entity `start` offset -- semantically inert
    // (the comment guards nothing), but the entity projection still
    // changes, so the gate must conservatively still mark `hub.ts` impactful.
    const edited = withFile(base, "hub.ts", fileText(base, "hub.ts").replace("export function second()", "// shift\nexport function second()"));
    const result = session.analyze({ files: edited });
    expect(result.build).toBe("incremental");
    expect(result.result).toEqual(analyzeProject({ files: edited }));
    expect(result.impactful_changed_paths).toEqual(["hub.ts"]);
    session.close();
  });

  it("a regex character-class hazard (embedded '/') inside a hub is impactful when the regex content is edited", () => {
    const base: AnalyzerFile[] = [
      { path: "hub.ts", text: "export function scan(s: string): boolean {\n  return /[/]a[/]/.test(s);\n}\n" },
      { path: "a.ts", text: "import { scan } from './hub';\nexport const result = scan('/a/');\n" },
      { path: "filler1.ts", text: "export const filler1 = 1;\n" },
    ];
    const session = new JsTsAnalysisSession();
    session.analyze({ files: base });

    const edited = withFile(base, "hub.ts", fileText(base, "hub.ts").replace("/[/]a[/]/", "/[/]b[/]/"));
    const result = session.analyze({ files: edited });
    expect(result.build).toBe("incremental");
    expect(result.result).toEqual(analyzeProject({ files: edited }));
    expect(result.impactful_changed_paths).toEqual(["hub.ts"]);
    session.close();
  });

  it("a template literal whose tail hides a '//' sequence is impactful when the tail is edited", () => {
    const base: AnalyzerFile[] = [
      { path: "hub.ts", text: "export function build(name: string): string {\n  return `prefix-${name}-//not-a-comment`;\n}\n" },
      { path: "a.ts", text: "import { build } from './hub';\nexport const result = build('x');\n" },
      { path: "filler1.ts", text: "export const filler1 = 1;\n" },
    ];
    const session = new JsTsAnalysisSession();
    session.analyze({ files: base });

    const edited = withFile(base, "hub.ts", fileText(base, "hub.ts").replace("not-a-comment", "still-not-a-comment"));
    const result = session.analyze({ files: edited });
    expect(result.build).toBe("incremental");
    expect(result.result).toEqual(analyzeProject({ files: edited }));
    expect(result.impactful_changed_paths).toEqual(["hub.ts"]);
    session.close();
  });

  it("a TS `///` triple-slash comment edit on a hub is impactful", () => {
    const base: AnalyzerFile[] = [
      { path: "hub.ts", text: "/// original note\nexport function noop(): void {}\n" },
      { path: "a.ts", text: "import { noop } from './hub';\nnoop();\nexport const done = true;\n" },
      { path: "filler1.ts", text: "export const filler1 = 1;\n" },
    ];
    const session = new JsTsAnalysisSession();
    session.analyze({ files: base });

    const edited = withFile(base, "hub.ts", fileText(base, "hub.ts").replace("/// original note", "/// updated note"));
    const result = session.analyze({ files: edited });
    expect(result.build).toBe("incremental");
    expect(result.result).toEqual(analyzeProject({ files: edited }));
    expect(result.impactful_changed_paths).toEqual(["hub.ts"]);
    session.close();
  });

  it("a TS `@ts-` pragma comment edit on a hub is impactful", () => {
    const base: AnalyzerFile[] = [
      { path: "hub.ts", text: "export function risky(): number {\n  // @ts-ignore\n  const x: number = 1;\n  return x;\n}\n" },
      { path: "a.ts", text: "import { risky } from './hub';\nexport const result = risky();\n" },
      { path: "filler1.ts", text: "export const filler1 = 1;\n" },
    ];
    const session = new JsTsAnalysisSession();
    session.analyze({ files: base });

    const edited = withFile(base, "hub.ts", fileText(base, "hub.ts").replace("// @ts-ignore", "// @ts-ignore -- still unsafe"));
    const result = session.analyze({ files: edited });
    expect(result.build).toBe("incremental");
    expect(result.result).toEqual(analyzeProject({ files: edited }));
    expect(result.impactful_changed_paths).toEqual(["hub.ts"]);
    session.close();
  });

  it("a .js file's JSDoc comment edit is impactful (checkJs means every JS comment guards)", () => {
    const base: AnalyzerFile[] = [
      { path: "hub.js", text: "/**\n * Adds two numbers.\n * @param {number} a\n * @param {number} b\n */\nexport function add(a, b) {\n  return a + b;\n}\n" },
      { path: "a.js", text: "import { add } from './hub';\nexport const sum = add(1, 2);\n" },
      { path: "filler1.js", text: "export const filler1 = 1;\n" },
    ];
    const session = new JsTsAnalysisSession();
    session.analyze({ files: base });

    const edited = withFile(base, "hub.js", fileText(base, "hub.js").replace("Adds two numbers.", "Adds two numbers together."));
    const result = session.analyze({ files: edited });
    expect(result.build).toBe("incremental");
    expect(result.result).toEqual(analyzeProject({ files: edited }));
    expect(result.impactful_changed_paths).toEqual(["hub.js"]);
    session.close();
  });

  it("a durable-cache-seeded session is conservative on its first post-seed edit, then gated on the next", () => {
    const base = hubFixture();
    const freshAnalysis: JsTsAnalysisResult = analyzeProject({ files: base });

    const seeded = new JsTsAnalysisSession();
    seeded.seedFromAnalysis(freshAnalysis, base);

    // First edit after a seed: the memo has no `semantic_hash`/`guard_hash`
    // (`seedFromAnalysis` has no AST to derive them from), so the gate
    // fails conservatively even though this edit is a pure comment append.
    const edited1 = withFile(base, "hub.ts", `${fileText(base, "hub.ts")}// probe\n`);
    const result1 = seeded.analyze({ files: edited1 });
    expect(result1.build).toBe("incremental");
    expect(result1.result).toEqual(analyzeProject({ files: edited1 }));
    expect(result1.impactful_changed_paths).toEqual(["hub.ts"]);

    // That rewalk stored fresh hashes for `hub.ts` -- a SECOND comment
    // append is now gated (self-healed).
    const edited2 = withFile(edited1, "hub.ts", `${fileText(edited1, "hub.ts")}// probe again\n`);
    const result2 = seeded.analyze({ files: edited2 });
    expect(result2.build).toBe("incremental");
    expect(result2.result).toEqual(analyzeProject({ files: edited2 }));
    expect(result2.impactful_changed_paths).toEqual([]);
    seeded.close();
  });
});
