import { describe, expect, it } from "vitest";
import type { QueryRequest, QueryScope } from "@urdira/contracts";
import { CursorCache, QueryEngine, type OperationEvaluation, type OperationInvocation, type QueryDataPort, type QueryStreamItem } from "../packages/engine/src/index.js";

/**
 * Bug Group 1 coverage: the recipe executor was a placeholder that called
 * every stage's operator with the SAME top-level recipe arguments and
 * `Object.assign`ed every stage's streams together. These tests drive the
 * REAL `recipeRegistry` definitions (`@urdira/contracts`) through the REAL
 * `QueryEngine`/`evaluateOperation` dispatch, against a small scriptable
 * fake `QueryDataPort` that asserts on the arguments each stage actually
 * receives -- proving argument_bindings/static_arguments/guards are
 * applied per-stage rather than the recipe's raw top-level arguments being
 * forwarded to everything.
 */

function scope(workspaceId: string): QueryScope {
  return { scope_type: "single_workspace", workspace_id: workspaceId };
}

function recipeRequest(recipeId: string, args: Readonly<Record<string, unknown>>, workspaceId = "workspace:recipe-test"): QueryRequest {
  return {
    api_version: 1,
    scope: scope(workspaceId),
    expression: { expression_type: "recipe", recipe_id: recipeId, arguments: args as never },
    options: { freshness: "current", wait_timeout_ms: 0, coverage_requirement: "accept_reported", evidence: { evidence: "summary", evidence_chain_depth: 1 }, diagnostics: { diagnostics: "none", diagnostic_detail: false }, snippets: { mode: "none", max_characters_per_snippet: 0, max_total_characters: 0, context_lines: 0 }, registry: { registry: "none", include_payload_schemas: false }, response_budget: { max_items: 1_000, max_characters: 1_000_000 } },
  };
}

function subj(value: Readonly<Record<string, unknown>>, key: string): QueryStreamItem {
  return { value, stable_sort_key: key };
}

type Handler = (operation: OperationInvocation) => OperationEvaluation | Promise<OperationEvaluation>;

class FakeDataPort implements QueryDataPort {
  constructor(private readonly handlers: Readonly<Record<string, Handler>>) {}
  async execute(operation: OperationInvocation): Promise<OperationEvaluation> {
    const handler = this.handlers[operation.operation_id];
    if (handler === undefined) return { streams: {} };
    return handler(operation);
  }
}

function engineFor(handlers: Readonly<Record<string, Handler>>): QueryEngine {
  return new QueryEngine({ data_port: new FakeDataPort(handlers), cursor_cache: new CursorCache({ signing_secret: "recipe-executor-test" }), now: () => "2026-08-14T00:00:00.000Z" });
}

function items(page: Awaited<ReturnType<QueryEngine["execute"]>>, stream: string): readonly QueryStreamItem[] {
  return page.streams[stream]?.items ?? [];
}

describe("recipe executor (Bug Group 1)", () => {
  it("core:locate_implementation: bindings project recipe args into the search stage, the recipe-only filter stage narrows to definitions by facet, and the source stage receives exactly the filtered subjects", async () => {
    const received: { search?: unknown; source?: unknown } = {};
    const engine = engineFor({
      "core:search_hybrid": (operation) => {
        received.search = operation.arguments;
        return {
          streams: {
            candidates: [
              subj({ subject_type: "record", record_id: "rec-def", kind: "function", universal_kind: "core:callable", facets: ["core:definition"] }, "1"),
              subj({ subject_type: "record", record_id: "rec-nondef", kind: "variable", universal_kind: "core:value", facets: [] }, "2"),
            ],
            semantic_coverage: [],
          },
        };
      },
      "core:get_source": (operation) => {
        received.source = operation.arguments;
        return { streams: { sources: [subj({ subject_type: "artifact", record_id: "rec-def" }, "1")] } };
      },
    });
    const page = await engine.execute(recipeRequest("core:locate_implementation", { query_text: "createTask", query_class: "identifier" }));
    // The search stage got the recipe's own $/query_text/$/query_class,
    // deep-merged with its static require_structural_subject.
    expect(received.search).toMatchObject({ query_text: "createTask", query_class: "identifier", require_structural_subject: true });
    // The recipe-only `filter` stage (static filter.kind_selector.any_facets
    // = ["core:definition"]) dropped rec-nondef -- only rec-def reached the
    // source stage's `subjects`.
    expect(received.source).toMatchObject({ subjects: [{ subject_type: "record", record_id: "rec-def" }], source: { mode: "relevant" }, include_related_evidence: true });
    expect(items(page, "implementations").map((entry) => (entry.value as { record_id: string }).record_id)).toEqual(["rec-def"]);
    expect(items(page, "sources")).toHaveLength(1);
  });

  it("core:resolve_and_find_references: a bare name with no context resolves through resolve -> references -> source", async () => {
    const received: { references?: unknown } = {};
    const engine = engineFor({
      "core:resolve_symbol": (operation) => {
        expect(operation.arguments).toMatchObject({ reference: "TaskService" });
        return { streams: { declarations: [subj({ subject_type: "record", record_id: "rec-ts", classification: "confirmed" }, "1")], candidates: [] } };
      },
      "core:find_references": (operation) => {
        received.references = operation.arguments;
        return { streams: { references: [subj({ subject_type: "record", record_id: "rec-ref-1", classification: "confirmed" }, "1")], owners: [subj({ subject_type: "record", record_id: "rec-owner-1" }, "1")] } };
      },
      "core:get_source": () => ({ streams: { sources: [subj({ subject_type: "artifact", record_id: "rec-ts" }, "1")] } }),
    });
    const page = await engine.execute(recipeRequest("core:resolve_and_find_references", { reference: "TaskService", include_declarations: false }));
    // resolve.declarations (the single confirmed record) was converted to
    // ONE SubjectSelector and bound into references.target -- not the raw,
    // unresolved top-level recipe arguments the placeholder used to forward.
    expect(received.references).toMatchObject({ target: { subject_type: "record", record_id: "rec-ts" } });
    expect(items(page, "declarations").map((entry) => (entry.value as { record_id: string }).record_id)).toEqual(["rec-ts"]);
    expect(items(page, "references")).toHaveLength(1);
    expect(items(page, "sources")).toHaveLength(1);
  });

  it("core:semantic_to_callers: the caller lane is seeded from the search stage's candidates (not an empty top-level subjects field) and its lane config comes from static_arguments", async () => {
    const engine = engineFor({
      "core:search_hybrid": () => ({ streams: { candidates: [subj({ subject_type: "record", record_id: "rec-fn", kind: "function", universal_kind: "core:callable" }, "1")], semantic_coverage: [] } }),
      "core:expand_relations": (operation) => {
        const args = operation.arguments as Record<string, unknown>;
        // Before Bug Group 1's fix, this stage received the RECIPE's raw
        // arguments (query_text/query_class/max_call_depth), so `subjects`
        // was undefined/empty and `direction` defaulted to outbound.
        expect(args["subjects"]).toEqual([{ subject_type: "record", record_id: "rec-fn" }]);
        expect(args["direction"]).toBe("inbound");
        expect(args["max_depth"]).toBe(3);
        expect((args["relations"] as { universal_kinds: readonly string[] }).universal_kinds).toContain("core:call");
        return { streams: { subjects: [subj({ subject_type: "record", record_id: "rec-caller" }, "1")], relations: [], paths: [] } };
      },
      "core:find_related_tests": () => ({ streams: { tests: [], fixtures: [], mocks: [], helpers: [] } }),
      "core:get_source": () => ({ streams: { sources: [] } }),
    });
    const page = await engine.execute(recipeRequest("core:semantic_to_callers", { query_text: "createTask", query_class: "identifier", max_call_depth: 3 }));
    expect(items(page, "callers").map((entry) => (entry.value as { record_id: string }).record_id)).toEqual(["rec-caller"]);
  });

  it("core:definition_to_instances: bind.record_selector turns the discovered definition set into a real RecordStructuralSelector", async () => {
    const received: { instances?: unknown } = {};
    const engine = engineFor({
      "core:discover_definitions": (operation) => {
        expect(operation.arguments).toMatchObject({ include_full_definitions: false, selector: { definition_types: ["record_kind", "facet", "language"] } });
        return {
          streams: {
            definitions: [subj({ subject_type: "definition", definition_type: "record_kind", definition_id: "core:callable" }, "1")],
            definition_set: [subj({ definitions: [{ definition_type: "record_kind", definition_id: "core:callable" }] }, "0")],
          },
        };
      },
      "core:find_records": (operation) => {
        received.instances = operation.arguments;
        return { streams: { records: [subj({ subject_type: "record", record_id: "rec-callable-1" }, "1")] } };
      },
    });
    const page = await engine.execute(recipeRequest("core:definition_to_instances", { matcher: { text: "core:callable", mode: "exact" } }));
    expect(received.instances).toMatchObject({ selector: { kind_selector: { universal_kinds: ["core:callable"] } } });
    expect(items(page, "instances").map((entry) => (entry.value as { record_id: string }).record_id)).toEqual(["rec-callable-1"]);
    expect(items(page, "definitions")).toHaveLength(1);
  });

  it("core:definition_to_instances: an empty definition_set produces the documented empty-result sentinel selector, not an unrestricted one", async () => {
    const received: { instances?: unknown } = {};
    const engine = engineFor({
      "core:discover_definitions": () => ({ streams: { definitions: [], definition_set: [] } }),
      "core:find_records": (operation) => {
        received.instances = operation.arguments;
        return { streams: { records: [] } };
      },
    });
    await engine.execute(recipeRequest("core:definition_to_instances", { matcher: { text: "core:does-not-exist", mode: "exact" } }));
    const selector = (received.instances as { selector: { kind_selector: { kinds: readonly string[] } } }).selector;
    expect(selector.kind_selector.kinds).toEqual(["core:__recipe_bind_empty_selector__"]);
  });

  it("core:prepare_symbol_change: the one_confirmed_subject guard rejects zero and multiple confirmed declarations with typed errors, without ever reaching later stages", async () => {
    let laterStageCalled = false;
    const zeroConfirmedEngine = engineFor({
      "core:resolve_symbol": () => ({ streams: { declarations: [], candidates: [subj({ subject_type: "record", record_id: "rec-possible" }, "1")] } }),
      "core:analyze_impact": () => { laterStageCalled = true; return { streams: {} }; },
    });
    await expect(zeroConfirmedEngine.execute(recipeRequest("core:prepare_symbol_change", { reference: "doesNotExist", change: { change_type: "delete" } }))).rejects.toMatchObject({ code: "core:selector_not_found" });
    expect(laterStageCalled).toBe(false);

    const ambiguousEngine = engineFor({
      "core:resolve_symbol": () => ({ streams: { declarations: [subj({ subject_type: "record", record_id: "rec-a", classification: "confirmed" }, "1"), subj({ subject_type: "record", record_id: "rec-b", classification: "confirmed" }, "2")], candidates: [] } }),
      "core:analyze_impact": () => { laterStageCalled = true; return { streams: {} }; },
    });
    await expect(ambiguousEngine.execute(recipeRequest("core:prepare_symbol_change", { reference: "duplicated", change: { change_type: "delete" } }))).rejects.toMatchObject({ code: "core:selector_ambiguous" });
    expect(laterStageCalled).toBe(false);
  });

  it("core:compare_workspaces: the comparison_roles_base_target guard rejects a scope missing base/target roles", async () => {
    const engine = engineFor({ "core:compare": () => ({ streams: {} }) });
    const request = recipeRequest("core:compare_workspaces", { comparison_kinds: ["added", "removed"], correlation_policy: "strict" });
    (request as { scope: QueryScope }).scope = { scope_type: "comparison", participants: [{ workspace_id: "ws-a", role: "left" }, { workspace_id: "ws-b", role: "right" }] };
    await expect(engine.execute(request)).rejects.toMatchObject({ code: "core:invalid_query_scope" });
  });

  // Bare-name minimal-argument coverage: every defaultable recipe argument
  // is optional in its `core:*Arguments@1` schema, and `query-plan.ts`
  // (`withRecipeArgumentDefaults`) injects the documented default before
  // canonicalization so a caller can pass ONLY the genuinely required
  // fields. These tests assert both that the call no longer rejects with
  // `core:request_invalid` for a missing field, and that the stage
  // receiving the defaulted field actually observes the injected value.
  it("core:resolve_and_find_references: a minimal call with only `reference` succeeds and defaults include_declarations to true", async () => {
    const received: { references?: unknown } = {};
    const engine = engineFor({
      "core:resolve_symbol": () => ({ streams: { declarations: [subj({ subject_type: "record", record_id: "rec-ts", classification: "confirmed" }, "1")], candidates: [] } }),
      "core:find_references": (operation) => {
        received.references = operation.arguments;
        return { streams: { references: [subj({ subject_type: "record", record_id: "rec-ref-1", classification: "confirmed" }, "1")], owners: [] } };
      },
      "core:get_source": () => ({ streams: { sources: [] } }),
    });
    const page = await engine.execute(recipeRequest("core:resolve_and_find_references", { reference: "BoxSelectionMode" }));
    expect(received.references).toMatchObject({ include_declarations: true });
    expect(items(page, "references")).toHaveLength(1);
  });

  it("core:locate_implementation: a minimal call with only `query_text` succeeds and defaults query_class to mixed", async () => {
    const received: { search?: unknown } = {};
    const engine = engineFor({
      "core:search_hybrid": (operation) => {
        received.search = operation.arguments;
        return { streams: { candidates: [], semantic_coverage: [] } };
      },
      "core:get_source": () => ({ streams: { sources: [] } }),
    });
    const page = await engine.execute(recipeRequest("core:locate_implementation", { query_text: "createTask" }));
    expect(received.search).toMatchObject({ query_text: "createTask", query_class: "mixed" });
    expect(items(page, "implementations")).toHaveLength(0);
  });

  it("core:semantic_to_callers: a minimal call with only `query_text` succeeds and defaults query_class to mixed and max_call_depth to 2", async () => {
    const received: { search?: unknown; callers?: unknown } = {};
    const engine = engineFor({
      "core:search_hybrid": (operation) => {
        received.search = operation.arguments;
        return { streams: { candidates: [subj({ subject_type: "record", record_id: "rec-fn", kind: "function", universal_kind: "core:callable" }, "1")], semantic_coverage: [] } };
      },
      "core:expand_relations": (operation) => {
        received.callers = operation.arguments;
        return { streams: { subjects: [], relations: [], paths: [] } };
      },
      "core:find_related_tests": () => ({ streams: { tests: [], fixtures: [], mocks: [], helpers: [] } }),
      "core:get_source": () => ({ streams: { sources: [] } }),
    });
    await engine.execute(recipeRequest("core:semantic_to_callers", { query_text: "createTask" }));
    expect(received.search).toMatchObject({ query_text: "createTask", query_class: "mixed" });
    expect(received.callers).toMatchObject({ max_depth: 2 });
    expect((received.callers as { subjects: unknown }).subjects).toEqual([{ subject_type: "record", record_id: "rec-fn" }]);
  });
});
