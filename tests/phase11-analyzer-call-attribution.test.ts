import { describe, expect, it } from "vitest";
import { analyzeProject } from "../packages/plugin-javascript-typescript/src/index.js";

/**
 * Bug Group 4.1 coverage: `ownerAt` in `packages/plugin-javascript-typescript/src/analyzer.ts`
 * only recognizes `core:callable` owners (function/method/constructor/accessor
 * declarations). A call expression at module top level, or nested inside a
 * `const foo = () => {...}` initializer (whose entity is `core:value`, since
 * arrow-function expressions are not separately entity-tracked), used to
 * climb past every ancestor without ever finding a callable owner and get
 * silently dropped -- no `core:call` relation emitted at all. The fix falls
 * back to the owning MODULE entity, mirroring the `core:references` handling
 * that already had this fallback.
 */
describe("analyzer call-site owner attribution (Bug Group 4.1)", () => {
  it("attributes a module-top-level call to the module entity with a resolved target_id", () => {
    const analysis = analyzeProject({ files: [
      { path: "src/lib.ts", text: "export function helper(): number { return 1; }" },
      { path: "src/main.ts", text: 'import { helper } from "./lib.js";\nhelper();\n' },
    ] });
    const moduleEntity = analysis.entities.find((entity) => entity.kind === "module" && entity.path === "src/main.ts");
    const helperEntity = analysis.entities.find((entity) => entity.name === "helper" && entity.kind === "function");
    expect(moduleEntity).toBeDefined();
    expect(helperEntity).toBeDefined();
    const moduleCalls = analysis.relations.filter((relation) => relation.kind === "core:call" && relation.source_id === moduleEntity!.id);
    expect(moduleCalls).toHaveLength(1);
    expect(moduleCalls[0]!.target_id).toBe(helperEntity!.id);
    expect(moduleCalls[0]!.classification).toBe("confirmed");
  });

  it("attributes a call nested inside a const-arrow-function initializer to the module entity, since the arrow itself has no tracked callable entity", () => {
    const analysis = analyzeProject({ files: [
      { path: "src/lib.ts", text: "export function helper(): number { return 1; }" },
      { path: "src/main.ts", text: 'import { helper } from "./lib.js";\nconst run = (): number => { return helper(); };\nrun();\n' },
    ] });
    const moduleEntity = analysis.entities.find((entity) => entity.kind === "module" && entity.path === "src/main.ts");
    const helperEntity = analysis.entities.find((entity) => entity.name === "helper" && entity.kind === "function");
    const runEntity = analysis.entities.find((entity) => entity.name === "run" && entity.kind === "variable");
    expect(moduleEntity).toBeDefined();
    expect(helperEntity).toBeDefined();
    expect(runEntity).toBeDefined();
    const moduleCalls = analysis.relations.filter((relation) => relation.kind === "core:call" && relation.source_id === moduleEntity!.id);
    // `run()` at top level, plus `helper()` nested inside `run`'s arrow body
    // -- both attributed to the module since neither call site has a
    // callable-entity ancestor of its own.
    expect(moduleCalls.length).toBeGreaterThanOrEqual(2);
    expect(moduleCalls.some((relation) => relation.target_id === helperEntity!.id)).toBe(true);
    expect(moduleCalls.some((relation) => relation.target_id === runEntity!.id)).toBe(true);
  });

  it("still attributes a call inside an ordinary function declaration to that function, unaffected by the module fallback", () => {
    const analysis = analyzeProject({ files: [
      { path: "src/lib.ts", text: "export function helper(): number { return 1; }" },
      { path: "src/main.ts", text: 'import { helper } from "./lib.js";\nexport function run(): number { return helper(); }\n' },
    ] });
    const moduleEntity = analysis.entities.find((entity) => entity.kind === "module" && entity.path === "src/main.ts");
    const runEntity = analysis.entities.find((entity) => entity.name === "run" && entity.kind === "function");
    const helperEntity = analysis.entities.find((entity) => entity.name === "helper" && entity.kind === "function");
    const callsFromRun = analysis.relations.filter((relation) => relation.kind === "core:call" && relation.source_id === runEntity!.id);
    expect(callsFromRun).toHaveLength(1);
    expect(callsFromRun[0]!.target_id).toBe(helperEntity!.id);
    expect(analysis.relations.some((relation) => relation.kind === "core:call" && relation.source_id === moduleEntity!.id)).toBe(false);
  });
});
