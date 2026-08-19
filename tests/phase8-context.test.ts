import { describe, expect, it } from "vitest";
import type { CompletenessReport, JsonValue, PluginAnalysisView, PluginResourceBudget } from "@urdira/contracts";
import {
  createPluginAnalysisSession,
  pluginInputAccessManifestDigest,
  PluginLookupInvalidationBinder,
  PluginSdkError,
  type ArtifactFilter,
  type ArtifactFindResult,
  type ArtifactLookupResult,
  type ArtifactReadResult,
  type DependencyClosureResult,
  type PluginAnalysisViewPort,
  type PluginDependencyClosurePort,
  type PluginRecordReference,
  type PluginRecordSelector,
  type LookupJournalCoverageInput,
  type LookupJournalCoverageResult,
  type LookupRevalidationSnapshot,
  type LookupInvalidationIndexPort,
  type BoundPluginLookupInvalidationDependency,
  type RecordGetResult,
  type RecordQueryResult,
} from "@urdira/plugin-sdk";

const completeness: CompletenessReport = {
  workspace_snapshot_binding_ids: ["binding-1"],
  overall_status: "complete",
  dimensions: [],
  diagnostic_record_ids: [],
};

const analysisView: PluginAnalysisView = Object.freeze({
  analysis_view_digest: "sha256:view",
  workspace_id: "workspace-1",
  candidate_generation_id: "candidate-7",
  base_snapshot_id: "snapshot-6",
  source_overlay_digest: "sha256:overlay",
  prerequisite_stage_set_digest: "sha256:stages",
  target_registry_snapshot_id: "registry-2",
  resolution_lock_id: "lock-2",
  configuration_revision_id: "config-4",
});

const sourceArtifact = Object.freeze({
  artifact_id: "artifact-source",
  artifact_version_id: "artifact-version-source",
  normalized_uri: "src/main.ts",
  artifact_kind: "source",
  content_hash: "sha256:source",
  byte_length: 17,
  encoding: "utf-8",
  language_ids: Object.freeze(["typescript"]),
  content_access: "readable",
});

const metadataArtifact = Object.freeze({
  artifact_id: "artifact-metadata",
  artifact_version_id: "artifact-version-metadata",
  normalized_uri: "vendor/blob.bin",
  artifact_kind: "binary",
  content_hash: "sha256:metadata",
  byte_length: 4096,
  encoding: "binary",
  language_ids: Object.freeze([]),
  content_access: "metadata_only",
});

const baseRecord = Object.freeze({
  view_type: "base",
  record_id: "record-base",
  record_digest: "sha256:record-base",
  category: "route",
  kind: "acme:route",
  universal_kind: "core:route",
  facets: Object.freeze(["acme:http"]),
  owner_artifact_id: sourceArtifact.artifact_id,
  owner_artifact_version_id: sourceArtifact.artifact_version_id,
  body: Object.freeze({ method: "GET" }),
});

const stagedRecord = Object.freeze({
  view_type: "staged",
  staged_record_id: "staged-prerequisite",
  producing_work_item_id: "work-prerequisite",
  proposal_record_key: "route:generated",
  validated_record_digest: "sha256:staged",
  category: "route",
  kind: "acme:route",
  universal_kind: "core:route",
  facets: Object.freeze(["acme:generated"]),
  owner_artifact_id: sourceArtifact.artifact_id,
  owner_artifact_version_id: sourceArtifact.artifact_version_id,
  body: Object.freeze({ method: "POST" }),
});

class FrozenViewPort implements PluginAnalysisViewPort {
  readonly calls: string[] = [];

  async listArtifacts(filter: ArtifactFilter | undefined): Promise<ArtifactLookupResult> {
    this.calls.push(`list:${JSON.stringify(filter)}`);
    return Object.freeze({ artifacts: Object.freeze([sourceArtifact, metadataArtifact]), completeness });
  }

  async findArtifact(normalized_uri: string): Promise<ArtifactFindResult> {
    this.calls.push(`find:${normalized_uri}`);
    return Object.freeze(normalized_uri === sourceArtifact.normalized_uri ? { artifact: sourceArtifact, completeness } : { completeness });
  }

  async readArtifact(artifact_id: string): Promise<ArtifactReadResult> {
    this.calls.push(`read:${artifact_id}`);
    if (artifact_id === metadataArtifact.artifact_id) {
      return Object.freeze({ artifact: metadataArtifact, content: "forbidden", host_path: "/private/vendor/blob.bin", completeness });
    }
    return Object.freeze({ artifact: sourceArtifact, content: "export const x=1;", host_path: "/private/src/main.ts", completeness });
  }

  async getRecord(reference: PluginRecordReference): Promise<RecordGetResult> {
    this.calls.push(`get:${JSON.stringify(reference)}`);
    return Object.freeze({
      record: reference.record_type === "base" ? baseRecord : stagedRecord,
      completeness,
    });
  }

  async queryRecords(selector: PluginRecordSelector): Promise<RecordQueryResult> {
    this.calls.push(`query:${JSON.stringify(selector)}`);
    return Object.freeze({ records: Object.freeze([baseRecord, stagedRecord]), completeness });
  }
}

class EmptyClosurePort implements PluginDependencyClosurePort {
  async baseRecordClosure(_record_id: string): Promise<DependencyClosureResult> {
    return Object.freeze({ proof: "proven", base_records: Object.freeze([]), staged_records: Object.freeze([]), artifact_version_ids: Object.freeze([]) });
  }

  async stagedRecordClosure(_staged_record_id: string): Promise<DependencyClosureResult> {
    return Object.freeze({ proof: "proven", base_records: Object.freeze([]), staged_records: Object.freeze([]), artifact_version_ids: Object.freeze([]) });
  }
}

function budget(overrides: Partial<PluginResourceBudget> = {}): PluginResourceBudget {
  return {
    deadline: "2099-01-01T00:00:00.000Z",
    max_memory_bytes: "1048576",
    max_output_bytes: "1048576",
    max_records: "100",
    max_dependencies: "100",
    max_context_operations: "100",
    max_context_bytes: "1048576",
    max_recursion_depth: "10",
    ...overrides,
  };
}

function session(port = new FrozenViewPort(), resourceBudget = budget(), signal = new AbortController().signal) {
  return createPluginAnalysisSession({
    analysis_view: analysisView,
    view_port: port,
    dependency_closure_port: new EmptyClosurePort(),
    cancellation_signal: signal,
    budget: resourceBudget,
    request_id: "request-1",
    request_digest: "sha256:request",
    plugin_id: "acme:analyzer",
    plugin_version: "1.2.3",
    analysis_digest: "sha256:implementation",
    analysis_configuration_digest: "sha256:analysis-config",
    call: "analyze",
    call_payload: Object.freeze({ artifact_id: sourceArtifact.artifact_id }),
  });
}

describe("plugin frozen analysis context", () => {
  it("returns the core's exact frozen view and exposes only five context operations", () => {
    const value = session();

    expect(value.analysis_view).toBe(analysisView);
    expect(Object.isFrozen(value.analysis_view)).toBe(true);
    expect(Object.keys(value.artifacts).sort()).toEqual(["find", "list", "read"]);
    expect(Object.keys(value.records).sort()).toEqual(["get", "query"]);
    expect("search" in value.records).toBe(false);
    expect("hostPath" in value).toBe(false);
  });

  it("returns frozen artifact values without leaking a host path", async () => {
    const value = session();

    const listed = await value.artifacts.list({ artifact_kind: "source" });
    const found = await value.artifacts.find("src/main.ts");
    const read = await value.artifacts.read("artifact-source");

    expect(listed).toEqual([sourceArtifact, metadataArtifact]);
    expect(found).toEqual(sourceArtifact);
    expect(read).toBe("export const x=1;");
    expect(Object.isFrozen(listed)).toBe(true);
  });

  it("rejects metadata-only artifact content", async () => {
    await expect(session().artifacts.read("artifact-metadata")).rejects.toMatchObject({
      code: "plugin-sdk:content_unavailable",
    });
  });

  it("supports base and prerequisite staged record references", async () => {
    const value = session();

    await expect(value.records.get({ record_type: "base", record_id: "record-base" })).resolves.toEqual(baseRecord);
    await expect(value.records.get({ record_type: "staged", staged_record_id: "staged-prerequisite" })).resolves.toEqual(stagedRecord);
    await expect(value.records.query({ kind: "acme:route" })).resolves.toEqual([baseRecord, stagedRecord]);
  });

  it("denies the first context call when an independent context budget is zero", async () => {
    const operationPort = new FrozenViewPort();
    await expect(session(operationPort, budget({ max_context_operations: "0" })).artifacts.find("src/main.ts")).rejects.toMatchObject({
      code: "plugin-sdk:context_budget_exhausted",
    });
    expect(operationPort.calls).toEqual([]);

    await expect(session(new FrozenViewPort(), budget({ max_context_bytes: "0" })).records.query({ kind: "acme:route" })).rejects.toMatchObject({
      code: "plugin-sdk:context_budget_exhausted",
    });
  });

  it("checks cancellation before and after each view-port call", async () => {
    const before = new AbortController();
    before.abort();
    const beforePort = new FrozenViewPort();
    await expect(session(beforePort, budget(), before.signal).artifacts.list(undefined)).rejects.toMatchObject({ code: "plugin-sdk:cancelled" });
    expect(beforePort.calls).toEqual([]);

    const after = new AbortController();
    class AbortingPort extends FrozenViewPort {
      override async findArtifact(uri: string): Promise<ArtifactFindResult> {
        const result = await super.findArtifact(uri);
        after.abort();
        return result;
      }
    }
    await expect(session(new AbortingPort(), budget(), after.signal).artifacts.find("src/main.ts")).rejects.toMatchObject({ code: "plugin-sdk:cancelled" });
  });
});

const partialCompleteness: CompletenessReport = {
  workspace_snapshot_binding_ids: ["binding-1"],
  overall_status: "partial",
  dimensions: [{
    workspace_snapshot_binding_ids: ["binding-1"],
    capability: "acme:routes",
    status: "partial",
    reason_codes: ["policy_limited"],
    affected_artifact_ids: [],
    diagnostic_record_ids: [],
  }],
  diagnostic_record_ids: [],
};

class CaptureViewPort implements PluginAnalysisViewPort {
  constructor(
    private readonly artifactList: ArtifactLookupResult = { artifacts: [], completeness },
    private readonly artifactFind: ArtifactFindResult = { completeness },
    private readonly artifactRead: ArtifactReadResult = { artifact: sourceArtifact, content: "export const x=1;", completeness },
    private readonly recordGet: RecordGetResult = { completeness },
    private readonly recordQuery: RecordQueryResult = { records: [], completeness },
  ) {}

  async listArtifacts(_filter: ArtifactFilter | undefined): Promise<ArtifactLookupResult> { return this.artifactList; }
  async findArtifact(_normalized_uri: string): Promise<ArtifactFindResult> { return this.artifactFind; }
  async readArtifact(_artifact_id: string): Promise<ArtifactReadResult> { return this.artifactRead; }
  async getRecord(_reference: PluginRecordReference): Promise<RecordGetResult> { return this.recordGet; }
  async queryRecords(_selector: PluginRecordSelector): Promise<RecordQueryResult> { return this.recordQuery; }
}

class FixtureClosurePort implements PluginDependencyClosurePort {
  readonly baseCalls: string[] = [];
  readonly stagedCalls: string[] = [];

  constructor(
    private readonly base: Readonly<Record<string, DependencyClosureResult>> = {},
    private readonly staged: Readonly<Record<string, DependencyClosureResult>> = {},
  ) {}

  async baseRecordClosure(record_id: string): Promise<DependencyClosureResult> {
    this.baseCalls.push(record_id);
    return this.base[record_id] ?? { proof: "proven", base_records: [], staged_records: [], artifact_version_ids: [] };
  }

  async stagedRecordClosure(staged_record_id: string): Promise<DependencyClosureResult> {
    this.stagedCalls.push(staged_record_id);
    return this.staged[staged_record_id] ?? { proof: "proven", base_records: [], staged_records: [], artifact_version_ids: [] };
  }
}

function captureSession(
  viewPort: PluginAnalysisViewPort,
  closurePort: PluginDependencyClosurePort = new FixtureClosurePort(),
  payload: JsonValue = { artifact_id: sourceArtifact.artifact_id },
  resourceBudget: PluginResourceBudget = budget(),
) {
  return createPluginAnalysisSession({
    analysis_view: analysisView,
    view_port: viewPort,
    dependency_closure_port: closurePort,
    cancellation_signal: new AbortController().signal,
    budget: resourceBudget,
    request_id: "request-1",
    request_digest: "sha256:request",
    plugin_id: "acme:analyzer",
    plugin_version: "1.2.3",
    analysis_digest: "sha256:implementation",
    analysis_configuration_digest: "sha256:analysis-config",
    call: "analyze",
    call_payload: payload,
  });
}

describe("automatic plugin access manifest capture", () => {
  it("records direct artifact and record accesses without duplicates", async () => {
    const port = new CaptureViewPort(
      { artifacts: [sourceArtifact], completeness },
      { artifact: sourceArtifact, completeness },
      { artifact: sourceArtifact, content: "export const x=1;", completeness },
      { record: baseRecord, completeness },
      { records: [baseRecord, stagedRecord], completeness },
    );
    const value = captureSession(port);

    await Promise.all([
      value.artifacts.list({ artifact_kind: "source" }),
      value.artifacts.find("src/main.ts"),
      value.artifacts.read("artifact-source"),
      value.artifacts.read("artifact-source"),
      value.records.get({ record_type: "base", record_id: "record-base" }),
      value.records.query({ kind: "acme:route" }),
    ]);
    const finalized = await value.finalize({});

    expect(finalized.manifest.artifact_version_entries).toHaveLength(1);
    expect(finalized.manifest.record_entries).toHaveLength(2);
    expect(finalized.manifest.lookup_entries).toHaveLength(4);
    expect(finalized.input_artifact_version_ids).toEqual(["artifact-version-source"]);
    expect(finalized.input_record_ids).toEqual(["record-base"]);
  });

  it("records absent and empty lookups with complete result-set digests", async () => {
    const value = captureSession(new CaptureViewPort());

    expect(await value.artifacts.list(undefined)).toEqual([]);
    expect(await value.artifacts.find("missing.ts")).toBeUndefined();
    expect(await value.records.get({ record_type: "base", record_id: "missing-record" })).toBeUndefined();
    expect(await value.records.query({ kind: "acme:missing" })).toEqual([]);
    const finalized = await value.finalize({});

    expect(finalized.manifest.lookup_entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ operation: "artifact_list", result_count: 0, completeness: "complete" }),
      expect.objectContaining({ operation: "artifact_find", result_count: 0, completeness: "complete" }),
      expect.objectContaining({ operation: "record_get", result_count: 0, completeness: "complete" }),
      expect.objectContaining({ operation: "record_query", result_count: 0, completeness: "complete" }),
    ]));
    expect(new Set(finalized.manifest.lookup_entries.map((entry) => entry.result_set_digest)).size).toBe(4);
  });

  it("records policy-limited lookup completeness", async () => {
    const value = captureSession(new CaptureViewPort(
      { artifacts: [sourceArtifact], completeness: partialCompleteness },
      { completeness },
      { artifact: sourceArtifact, content: "export const x=1;", completeness },
      { completeness },
      { records: [baseRecord], completeness: partialCompleteness },
    ));

    await value.artifacts.list({ artifact_kind: "source" });
    await value.records.query({ kind: "acme:route" });
    const finalized = await value.finalize({});

    expect(finalized.manifest.lookup_entries).toEqual([
      expect.objectContaining({ operation: "artifact_list", completeness: "policy_limited", result_count: 1 }),
      expect.objectContaining({ operation: "record_query", completeness: "policy_limited", result_count: 1 }),
    ]);
  });

  it("emits only the authoritative access-manifest lookup and record fields", async () => {
    const value = captureSession(new CaptureViewPort(
      { artifacts: [sourceArtifact], completeness: partialCompleteness },
      { completeness },
      { artifact: sourceArtifact, content: "export const x=1;", completeness },
      { completeness },
      { records: [baseRecord, stagedRecord], completeness },
    ));

    await value.artifacts.list({ artifact_kind: "source" });
    await value.artifacts.read(sourceArtifact.artifact_id);
    await value.records.query({ kind: "acme:route" });
    const finalized = await value.finalize({});

    expect(finalized.manifest.artifact_version_entries).toEqual([
      expect.objectContaining({ artifact_version_id: sourceArtifact.artifact_version_id, access_modes: ["artifact_list", "artifact_read"] }),
    ]);
    expect(finalized.manifest.lookup_entries.map((entry) => entry.operation)).toEqual(["artifact_list", "record_query"]);
    expect(finalized.manifest.lookup_entries.map((entry) => entry.completeness)).toEqual(["policy_limited", "complete"]);
    expect(finalized.manifest.lookup_entries.every((entry) => Object.keys(entry).sort().join(",") === [
      "analysis_view_digest", "completeness", "normalized_selector_or_address", "operation", "result_count", "result_set_digest",
    ].sort().join(","))).toBe(true);
    expect(finalized.manifest.record_entries.map((entry) => Object.keys(entry).sort())).toEqual([
      ["input_type", "record_digest", "record_id"],
      ["input_type", "producing_work_item_id", "proposal_record_key", "staged_record_id", "validated_record_digest"],
    ]);
    expect(finalized.manifest.record_entries.map((entry) => entry.input_type)).toEqual(["base_record", "staged_record"]);
  });

  it("orders non-ASCII manifest data without locale-sensitive comparison", async () => {
    const bmpPrivateUse = "\uE000";
    const supplementaryPlane = "\u{10000}";
    const artifact = (suffix: string) => Object.freeze({
      ...sourceArtifact,
      artifact_id: `artifact-${suffix}`,
      artifact_version_id: `artifact-version-${suffix}`,
      normalized_uri: `src/${suffix}.ts`,
      content_hash: `sha256:${suffix}`,
    });
    const firstArtifacts = [artifact(supplementaryPlane), artifact("å"), artifact("z"), artifact(bmpPrivateUse), artifact("ä")];
    const secondArtifacts = [firstArtifacts[3]!, firstArtifacts[2]!, firstArtifacts[4]!, firstArtifacts[0]!, firstArtifacts[1]!];
    const first = captureSession(new CaptureViewPort({ artifacts: firstArtifacts, completeness }, { completeness }));
    const second = captureSession(new CaptureViewPort({ artifacts: secondArtifacts, completeness }, { completeness }));
    const originalDescriptor = Object.getOwnPropertyDescriptor(String.prototype, "localeCompare")!;
    let firstFinal: Awaited<ReturnType<typeof first.finalize>> | undefined;
    let secondFinal: Awaited<ReturnType<typeof second.finalize>> | undefined;
    let dependencies: readonly BoundPluginLookupInvalidationDependency[] | undefined;

    try {
      Object.defineProperty(String.prototype, "localeCompare", {
        configurable: true,
        writable: true,
        value: () => { throw new Error("locale-sensitive ordering is forbidden"); },
      });
      await first.artifacts.list(undefined);
      await first.artifacts.find("missing.ts");
      await second.artifacts.find("missing.ts");
      await second.artifacts.list(undefined);
      firstFinal = await first.finalize({});
      secondFinal = await second.finalize({});
      dependencies = await invalidationBinder(
        new InMemoryLookupInvalidationIndex({ artifact_list: ["*"] }),
      ).bind(bindingInput(firstFinal.manifest));
    } finally {
      Object.defineProperty(String.prototype, "localeCompare", originalDescriptor);
    }

    expect(firstFinal!.manifest.manifest_digest).toBe(secondFinal!.manifest.manifest_digest);
    expect(firstFinal!.analysis_input_digest).toBe(secondFinal!.analysis_input_digest);
    expect(firstFinal!.manifest.artifact_version_entries.map((entry) => entry.artifact_version_id)).toEqual([
      "artifact-version-z", "artifact-version-ä", "artifact-version-å", `artifact-version-${bmpPrivateUse}`, `artifact-version-${supplementaryPlane}`,
    ]);
    expect(dependencies!.map((entry) => entry.operation)).toEqual(["artifact_find", "artifact_list"]);
  });

  it("canonicalizes duplicate concurrent reads and different interleavings", async () => {
    const first = captureSession(new CaptureViewPort(
      { artifacts: [metadataArtifact, sourceArtifact], completeness },
      { artifact: sourceArtifact, completeness },
      { artifact: sourceArtifact, content: "export const x=1;", completeness },
      { record: baseRecord, completeness },
      { records: [stagedRecord, baseRecord], completeness },
    ));
    const second = captureSession(new CaptureViewPort(
      { artifacts: [sourceArtifact, metadataArtifact], completeness },
      { artifact: sourceArtifact, completeness },
      { artifact: sourceArtifact, content: "export const x=1;", completeness },
      { record: baseRecord, completeness },
      { records: [baseRecord, stagedRecord], completeness },
    ));

    await Promise.all([first.records.query({ kind: "acme:route" }), first.artifacts.list(undefined), first.artifacts.find("src/main.ts"), first.artifacts.find("src/main.ts")]);
    await second.artifacts.find("src/main.ts");
    await second.artifacts.list(undefined);
    await second.records.query({ kind: "acme:route" });
    const firstFinal = await first.finalize({});
    const secondFinal = await second.finalize({});

    expect(firstFinal.manifest.manifest_digest).toBe(secondFinal.manifest.manifest_digest);
    expect(firstFinal.analysis_input_digest).toBe(secondFinal.analysis_input_digest);
  });

  it("expands proven base and staged closures and excludes staged IDs from input_record_ids", async () => {
    const closure = new FixtureClosurePort(
      {
        "record-base": {
          proof: "proven",
          base_records: [{ input_type: "base_record", record_id: "record-transitive", record_digest: "sha256:record-transitive" }],
          staged_records: [],
          artifact_version_ids: ["artifact-version-transitive-base"],
        },
      },
      {
        "staged-prerequisite": {
          proof: "proven",
          base_records: [{ input_type: "base_record", record_id: "record-stage-base", record_digest: "sha256:record-stage-base" }],
          staged_records: [{ input_type: "staged_record", staged_record_id: "staged-producer", producing_work_item_id: "work-producer", proposal_record_key: "producer:key", validated_record_digest: "sha256:producer" }],
          artifact_version_ids: ["artifact-version-transitive-staged"],
        },
      },
    );
    const value = captureSession(new CaptureViewPort(
      { artifacts: [], completeness }, { completeness }, { artifact: sourceArtifact, content: "", completeness }, { completeness },
      { records: [baseRecord, stagedRecord], completeness },
    ), closure);

    await value.records.query({ kind: "acme:route" });
    const finalized = await value.finalize({});

    expect(closure.baseCalls).toEqual(["record-base"]);
    expect(closure.stagedCalls).toEqual(["staged-prerequisite"]);
    expect(finalized.input_record_ids).toEqual(["record-base", "record-stage-base", "record-transitive"]);
    expect(finalized.input_record_ids).not.toContain("staged-prerequisite");
    expect(finalized.input_artifact_version_ids).toEqual(["artifact-version-source", "artifact-version-transitive-base", "artifact-version-transitive-staged"]);
  });

  it("fails closed on unprovable closure unless an exact conservative fallback is authorized", async () => {
    const unavailable: DependencyClosureResult = { proof: "unavailable", base_records: [], staged_records: [], artifact_version_ids: [] };
    const closure = new FixtureClosurePort({ "record-base": unavailable });
    const port = new CaptureViewPort(undefined, undefined, undefined, { record: baseRecord, completeness });
    const denied = captureSession(port, closure);
    await denied.records.get({ record_type: "base", record_id: "record-base" });
    await expect(denied.finalize({})).rejects.toMatchObject({ code: "plugin-sdk:dependency_closure_unavailable" });

    const allowed = captureSession(port, closure);
    await allowed.records.get({ record_type: "base", record_id: "record-base" });
    const finalized = await allowed.finalize({
      authorized_conservative_closure: {
        proof: "proven",
        base_records: [{ input_type: "base_record", record_id: "record-conservative", record_digest: "sha256:conservative" }],
        staged_records: [],
        artifact_version_ids: ["artifact-version-conservative"],
      },
    });
    expect(finalized.input_record_ids).toEqual(["record-base", "record-conservative"]);
    expect(finalized.input_artifact_version_ids).toEqual(["artifact-version-conservative", "artifact-version-source"]);
  });

  it("binds request, view, implementation, configuration, call, and payload into analysis_input_digest", async () => {
    const first = captureSession(new CaptureViewPort(), new FixtureClosurePort(), { mode: "one" });
    const second = captureSession(new CaptureViewPort(), new FixtureClosurePort(), { mode: "two" });
    const firstFinal = await first.finalize({});
    const secondFinal = await second.finalize({});

    expect(firstFinal.analysis_input_digest).toMatch(/^sha256:/u);
    expect(firstFinal.analysis_input_digest).not.toBe(secondFinal.analysis_input_digest);
  });
});

class InMemoryLookupInvalidationIndex implements LookupInvalidationIndexPort {
  readonly persisted: BoundPluginLookupInvalidationDependency[] = [];
  readonly coverageCalls: LookupJournalCoverageInput[] = [];
  readonly snapshots = new Map<string, LookupRevalidationSnapshot>();
  failPersistence = false;

  constructor(private readonly journaled: Readonly<Record<string, readonly string[]>> = {}) {}

  async journalCoverage(input: LookupJournalCoverageInput): Promise<LookupJournalCoverageResult> {
    this.coverageCalls.push(input);
    return { journaled_dimensions: this.journaled[input.operation] ?? [] };
  }

  async persistLookupDependencies(dependencies: readonly BoundPluginLookupInvalidationDependency[]): Promise<void> {
    if (this.failPersistence) throw new Error("index persistence unavailable");
    this.persisted.push(...dependencies);
  }

  async currentLookupResult(dependency: BoundPluginLookupInvalidationDependency): Promise<LookupRevalidationSnapshot> {
    const result = this.snapshots.get(dependency.lookup_dependency_id);
    if (result === undefined) throw new Error(`missing snapshot for ${dependency.lookup_dependency_id}`);
    return result;
  }
}

async function emptyLookupManifest() {
  const value = captureSession(new CaptureViewPort());
  await value.artifacts.list(undefined);
  await value.artifacts.find("missing.ts");
  await value.records.get({ record_type: "base", record_id: "missing-record" });
  await value.records.query({ kind: "acme:missing" });
  return (await value.finalize({})).manifest;
}

function bindingInput(manifest: Awaited<ReturnType<typeof emptyLookupManifest>>, overrides: Record<string, unknown> = {}) {
  return {
    manifest,
    workspace_id: "workspace-1",
    consumer_type: "partition_set" as const,
    consumer_id: "partition-1",
    valid_from_generation: 7,
    authorized_conservative_scopes: [],
    cancellation_signal: new AbortController().signal,
    ...overrides,
  };
}

const invalidationMaterializationLimits = Object.freeze({ max_items: 1_000, max_depth: 64, max_nodes: 10_000, max_bytes: 1_048_576 });

function invalidationBinder(index: LookupInvalidationIndexPort): PluginLookupInvalidationBinder {
  return new PluginLookupInvalidationBinder(index, invalidationMaterializationLimits);
}

describe("plugin lookup invalidation binding and revalidation", () => {
  it("rejects forged, non-exact, duplicate, and cyclic manifests before persistence", async () => {
    const manifest = await emptyLookupManifest();
    const duplicateLookup = { ...manifest, lookup_entries: [...manifest.lookup_entries, manifest.lookup_entries[0]!] };
    const conflictingLookupEntries = [
      { ...manifest.lookup_entries[0]!, result_set_digest: "sha256:conflict-a" },
      { ...manifest.lookup_entries[0]!, result_set_digest: "sha256:conflict-b" },
      ...manifest.lookup_entries.slice(1),
    ];
    const conflictingDigestInput = {
      request_id: manifest.request_id,
      analysis_view_digest: manifest.analysis_view_digest,
      artifact_version_entries: manifest.artifact_version_entries,
      record_entries: manifest.record_entries,
      lookup_entries: conflictingLookupEntries,
      transitive_artifact_version_ids: manifest.transitive_artifact_version_ids,
    };
    const conflictingLookup = {
      plugin_input_access_manifest_id: manifest.plugin_input_access_manifest_id,
      ...conflictingDigestInput,
      manifest_digest: pluginInputAccessManifestDigest(conflictingDigestInput),
    };
    const cyclicExtra: Record<string, unknown> = {};
    cyclicExtra["self"] = cyclicExtra;
    const variants: readonly unknown[] = [
      { ...manifest, plugin_input_access_manifest_id: "sha256:forged-id" },
      { ...manifest, manifest_digest: "sha256:forged-manifest" },
      { ...manifest, unexpected: true },
      { ...manifest, lookup_entries: [{ ...manifest.lookup_entries[0]!, unexpected: true }, ...manifest.lookup_entries.slice(1)] },
      duplicateLookup,
      conflictingLookup,
      { ...manifest, unexpected: cyclicExtra },
    ];

    for (const variant of variants) {
      const index = new InMemoryLookupInvalidationIndex({ artifact_list: ["*"], record_query: ["kind"] });
      await expect(invalidationBinder(index).bind(bindingInput(variant as Awaited<ReturnType<typeof emptyLookupManifest>>)))
        .rejects.toMatchObject({ code: "plugin-sdk:lookup_binding_invalid" });
      expect(index.persisted).toEqual([]);
    }
  });

  it("materializes a stateful manifest getter once before validating and persisting", async () => {
    const manifest = await emptyLookupManifest();
    let reads = 0;
    const stateful = Object.defineProperty({ ...manifest }, "lookup_entries", {
      configurable: true,
      enumerable: true,
      get: () => {
        reads += 1;
        if (reads > 1) throw new Error("STATEFUL_MANIFEST_SECRET /private/path");
        return manifest.lookup_entries;
      },
    }) as typeof manifest;
    const index = new InMemoryLookupInvalidationIndex({ artifact_list: ["*"], record_query: ["kind"] });

    await expect(invalidationBinder(index).bind(bindingInput(stateful))).resolves.toHaveLength(4);
    expect(reads).toBe(1);
    expect(index.persisted).toHaveLength(4);
  });

  it("lowers exact URI and record addresses and only fully journaled selectors", async () => {
    const manifest = await emptyLookupManifest();
    const index = new InMemoryLookupInvalidationIndex({ artifact_list: ["*"], record_query: ["kind"] });
    const dependencies = await invalidationBinder(index).bind(bindingInput(manifest));

    expect(dependencies.map((entry) => [entry.operation, entry.invalidation_scope])).toEqual([
      ["artifact_find", "exact_address"],
      ["artifact_list", "exact_selector"],
      ["record_get", "exact_address"],
      ["record_query", "exact_selector"],
    ]);
    expect(Object.keys(dependencies[0]!).sort()).toEqual([
      "consumer_id", "consumer_type", "invalidation_scope", "lookup_dependency_id", "normalized_selector_or_address", "operation",
      "previous_result_set_digest", "selector_digest", "valid_from_generation", "workspace_id",
    ]);
    expect(dependencies.every((entry) => entry.consumer_type === "partition_set")).toBe(true);
    expect(index.persisted).toEqual(dependencies);
    expect(index.coverageCalls.map((entry) => [entry.operation, entry.selector_dimensions])).toEqual([
      ["artifact_list", ["*"]],
      ["record_query", ["kind"]],
    ]);
  });

  it("requires an authorized conservative fallback for incomplete selector journal coverage", async () => {
    const value = captureSession(new CaptureViewPort());
    await value.records.query({ kind: "acme:route", facet: "acme:http" });
    const manifest = (await value.finalize({})).manifest;
    const index = new InMemoryLookupInvalidationIndex({ record_query: ["kind"] });
    const binder = invalidationBinder(index);

    await expect(binder.bind(bindingInput(manifest))).rejects.toMatchObject({ code: "plugin-sdk:lookup_scope_unauthorized" });
    const dependencies = await binder.bind(bindingInput(manifest, {
      authorized_conservative_scopes: [{ operation: "record_query", scope: "plugin" }],
    }));
    expect(dependencies).toEqual([expect.objectContaining({ operation: "record_query", invalidation_scope: "plugin" })]);

    const partial = captureSession(new CaptureViewPort(undefined, { artifact: sourceArtifact, completeness: partialCompleteness }));
    await partial.artifacts.find("src/main.ts");
    const partialManifest = (await partial.finalize({})).manifest;
    const partialDependencies = await binder.bind(bindingInput(partialManifest, {
      authorized_conservative_scopes: [{ operation: "artifact_find", scope: "workspace" }],
    }));
    expect(partialDependencies).toEqual([expect.objectContaining({ operation: "artifact_find", invalidation_scope: "workspace" })]);
  });

  it("enforces partition owner absence and record or projection owner presence", async () => {
    const manifest = await emptyLookupManifest();
    const index = new InMemoryLookupInvalidationIndex({ artifact_list: ["*"], record_query: ["kind"] });
    const binder = invalidationBinder(index);

    await expect(binder.bind(bindingInput(manifest, { owner_artifact_id: "artifact-source", owner_artifact_version_id: "artifact-version-source" }))).rejects.toMatchObject({
      code: "plugin-sdk:lookup_binding_invalid",
    });
    await expect(binder.bind(bindingInput(manifest, { consumer_type: "record_set", consumer_id: "record-output" }))).rejects.toMatchObject({
      code: "plugin-sdk:lookup_binding_invalid",
    });
    const recordDependencies = await binder.bind(bindingInput(manifest, {
      consumer_type: "record_set",
      consumer_id: "record-output",
      owner_artifact_id: "artifact-source",
      owner_artifact_version_id: "artifact-version-source",
    }));
    expect(recordDependencies.every((entry) => entry.owner_artifact_id === "artifact-source" && entry.owner_artifact_version_id === "artifact-version-source")).toBe(true);
  });

  it("rejects the binding when lookup dependency persistence fails", async () => {
    const manifest = await emptyLookupManifest();
    const index = new InMemoryLookupInvalidationIndex({ artifact_list: ["*"], record_query: ["kind"] });
    index.failPersistence = true;

    await expect(invalidationBinder(index).bind(bindingInput(manifest))).rejects.toMatchObject({
      code: "plugin-sdk:port_failure",
      details: { port: "lookup_persistence" },
    });
    expect(index.persisted).toEqual([]);
  });

  it("uses half-open generations and invalidates an empty complete lookup that becomes non-empty", async () => {
    const value = captureSession(new CaptureViewPort());
    await value.records.query({ kind: "acme:missing" });
    const manifest = (await value.finalize({})).manifest;
    const index = new InMemoryLookupInvalidationIndex({ record_query: ["kind"] });
    const binder = invalidationBinder(index);
    const [dependency] = await binder.bind(bindingInput(manifest));
    expect(dependency).toMatchObject({ valid_from_generation: 7 });
    expect("valid_to_generation" in dependency!).toBe(false);
    index.snapshots.set(dependency!.lookup_dependency_id, {
      analysis_view_digest: analysisView.analysis_view_digest,
      completeness,
      results: [{ input_type: "base_record", record_id: "record-new", record_digest: "sha256:new", transitive_artifact_version_ids: [] }],
    });

    await expect(binder.revalidate({ dependencies: [dependency!], generation: 6, cancellation_signal: new AbortController().signal })).resolves.toEqual({
      invalidated_consumer_ids: [], changed_lookup_dependency_ids: [],
    });
    await expect(binder.revalidate({ dependencies: [dependency!], generation: 7, cancellation_signal: new AbortController().signal })).resolves.toEqual({
      invalidated_consumer_ids: ["partition-1"], changed_lookup_dependency_ids: [dependency!.lookup_dependency_id],
    });
    const closed = { ...dependency!, valid_to_generation: 9 };
    await expect(binder.revalidate({ dependencies: [closed], generation: 9, cancellation_signal: new AbortController().signal })).resolves.toEqual({
      invalidated_consumer_ids: [], changed_lookup_dependency_ids: [],
    });
  });

  it("does not invalidate when a complete result is merely reordered", async () => {
    const value = captureSession(new CaptureViewPort(
      { artifacts: [], completeness }, { completeness }, { artifact: sourceArtifact, content: "", completeness }, { completeness },
      { records: [stagedRecord, baseRecord], completeness },
    ));
    await value.records.query({ kind: "acme:route" });
    const manifest = (await value.finalize({})).manifest;
    const index = new InMemoryLookupInvalidationIndex({ record_query: ["kind"] });
    const binder = invalidationBinder(index);
    const [dependency] = await binder.bind(bindingInput(manifest));
    index.snapshots.set(dependency!.lookup_dependency_id, {
      analysis_view_digest: analysisView.analysis_view_digest,
      completeness,
      results: [
        { input_type: "base_record", record_id: "record-base", record_digest: "sha256:record-base" },
        { input_type: "staged_record", staged_record_id: "staged-prerequisite", producing_work_item_id: "work-prerequisite", proposal_record_key: "route:generated", validated_record_digest: "sha256:staged" },
      ],
    });

    await expect(binder.revalidate({ dependencies: [dependency!], generation: 7, cancellation_signal: new AbortController().signal })).resolves.toEqual({
      invalidated_consumer_ids: [], changed_lookup_dependency_ids: [],
    });
  });

  it("invalidates when a transitive artifact dependency changes", async () => {
    const value = captureSession(new CaptureViewPort(undefined, undefined, undefined, { record: baseRecord, completeness }), new FixtureClosurePort({
      "record-base": { proof: "proven", base_records: [], staged_records: [], artifact_version_ids: ["artifact-version-dependency-v1"] },
    }));
    await value.records.get({ record_type: "base", record_id: "record-base" });
    const manifest = (await value.finalize({})).manifest;
    const index = new InMemoryLookupInvalidationIndex();
    const binder = invalidationBinder(index);
    const [dependency] = await binder.bind(bindingInput(manifest));
    index.snapshots.set(dependency!.lookup_dependency_id, {
      analysis_view_digest: analysisView.analysis_view_digest,
      completeness,
      results: [{ input_type: "base_record", record_id: "record-base", record_digest: "sha256:record-base", transitive_artifact_version_ids: ["artifact-version-dependency-v1"] }],
    });
    await expect(binder.revalidate({ dependencies: [dependency!], generation: 7, cancellation_signal: new AbortController().signal })).resolves.toEqual({
      invalidated_consumer_ids: [], changed_lookup_dependency_ids: [],
    });

    index.snapshots.set(dependency!.lookup_dependency_id, {
      analysis_view_digest: analysisView.analysis_view_digest,
      completeness,
      results: [{ input_type: "base_record", record_id: "record-base", record_digest: "sha256:record-base", transitive_artifact_version_ids: ["artifact-version-dependency-v2"] }],
    });

    const result = await binder.revalidate({ dependencies: [dependency!], generation: 7, cancellation_signal: new AbortController().signal });
    expect(result.invalidated_consumer_ids).toEqual(["partition-1"]);
  });
});

describe("Task 2 reviewed boundary regressions", () => {
  it("snapshots every digest-binding input, payload, port, and signal at session creation", async () => {
    const originalClosure = new FixtureClosurePort({
      "record-base": { proof: "proven", base_records: [], staged_records: [], artifact_version_ids: ["artifact-version-original-closure"] },
    });
    const swappedClosure = new FixtureClosurePort({
      "record-base": { proof: "proven", base_records: [], staged_records: [], artifact_version_ids: ["artifact-version-swapped-closure"] },
    });
    const originalPort = new CaptureViewPort(undefined, { artifact: sourceArtifact, completeness }, undefined, { record: baseRecord, completeness });
    const swappedPort = new CaptureViewPort(undefined, { artifact: metadataArtifact, completeness }, undefined, { record: stagedRecord, completeness });
    const payload = { mode: "original", nested: { limit: 1 } };
    const originalSignal = new AbortController();
    const swappedSignal = new AbortController();
    swappedSignal.abort();
    const mutableInput: any = {
      analysis_view: analysisView,
      view_port: originalPort,
      dependency_closure_port: originalClosure,
      cancellation_signal: originalSignal.signal,
      budget: budget(),
      request_id: "request-1",
      request_digest: "sha256:request",
      plugin_id: "acme:analyzer",
      plugin_version: "1.2.3",
      analysis_digest: "sha256:implementation",
      analysis_configuration_digest: "sha256:analysis-config",
      call: "analyze",
      call_payload: payload,
    };
    const subject = createPluginAnalysisSession(mutableInput);
    const reference = createPluginAnalysisSession({ ...mutableInput, call_payload: { mode: "original", nested: { limit: 1 } } });

    mutableInput.analysis_view = { ...analysisView, analysis_view_digest: "sha256:mutated-view" };
    mutableInput.view_port = swappedPort;
    mutableInput.dependency_closure_port = swappedClosure;
    mutableInput.cancellation_signal = swappedSignal.signal;
    mutableInput.request_id = "mutated-request";
    mutableInput.request_digest = "sha256:mutated-request";
    mutableInput.plugin_id = "evil:plugin";
    mutableInput.plugin_version = "9.9.9";
    mutableInput.analysis_digest = "sha256:mutated-implementation";
    mutableInput.analysis_configuration_digest = "sha256:mutated-config";
    mutableInput.call = "mutated-call";
    payload.mode = "mutated";
    payload.nested.limit = 999;

    await expect(subject.artifacts.find("src/main.ts")).resolves.toEqual(sourceArtifact);
    await subject.records.get({ record_type: "base", record_id: "record-base" });
    await reference.artifacts.find("src/main.ts");
    await reference.records.get({ record_type: "base", record_id: "record-base" });
    const subjectFinal = await subject.finalize({});
    const referenceFinal = await reference.finalize({});

    expect(subject.analysis_view).toBe(analysisView);
    expect(subjectFinal.analysis_input_digest).toBe(referenceFinal.analysis_input_digest);
    expect(subjectFinal.input_artifact_version_ids).toContain("artifact-version-original-closure");
    expect(subjectFinal.input_artifact_version_ids).not.toContain("artifact-version-swapped-closure");
  });

  it("deduplicates identical lookup rows before count and digest", async () => {
    const duplicate = captureSession(new CaptureViewPort(
      { artifacts: [sourceArtifact, sourceArtifact], completeness }, undefined, undefined, undefined,
      { records: [baseRecord, baseRecord], completeness },
    ));
    const single = captureSession(new CaptureViewPort(
      { artifacts: [sourceArtifact], completeness }, undefined, undefined, undefined,
      { records: [baseRecord], completeness },
    ));
    await duplicate.artifacts.list({ artifact_kind: "source" });
    await duplicate.records.query({ kind: "acme:route" });
    await single.artifacts.list({ artifact_kind: "source" });
    await single.records.query({ kind: "acme:route" });
    const duplicateFinal = await duplicate.finalize({});
    const singleFinal = await single.finalize({});

    expect(duplicateFinal.manifest.lookup_entries.map((entry) => entry.result_count)).toEqual([1, 1]);
    expect(duplicateFinal.manifest.manifest_digest).toBe(singleFinal.manifest.manifest_digest);
  });

  it("fails closed when one artifact or record identity has conflicting digests", async () => {
    const conflictingArtifact = { ...sourceArtifact, content_hash: "sha256:conflicting-artifact" };
    const artifactSession = captureSession(new CaptureViewPort({ artifacts: [sourceArtifact, conflictingArtifact], completeness }));
    await expect(artifactSession.artifacts.list(undefined)).rejects.toMatchObject({ code: "plugin-sdk:analysis_view_invalid" });

    const conflictingRecord = { ...baseRecord, record_digest: "sha256:conflicting-record" };
    const recordSession = captureSession(new CaptureViewPort(undefined, undefined, undefined, undefined, { records: [baseRecord, conflictingRecord], completeness }));
    await expect(recordSession.records.query({ kind: "acme:route" })).rejects.toMatchObject({ code: "plugin-sdk:analysis_view_invalid" });
  });

  it("sanitizes hostile failures from every port family", async () => {
    const hostile = "SECRET_TOKEN at /Users/private/repository";
    const assertSafe = async (promise: Promise<unknown>, port: string): Promise<void> => {
      let observed: unknown;
      try { await promise; } catch (error) { observed = error; }
      expect(observed).toBeInstanceOf(PluginSdkError);
      expect(observed).toMatchObject({ code: "plugin-sdk:port_failure", details: { port } });
      expect(JSON.stringify((observed as PluginSdkError).toJSON())).not.toContain("SECRET_TOKEN");
      expect((observed as Error).message).not.toContain("/Users/private");
    };

    class HostileViewPort extends CaptureViewPort {
      override async findArtifact(_uri: string): Promise<ArtifactFindResult> { throw new Error(hostile); }
    }
    await assertSafe(captureSession(new HostileViewPort()).artifacts.find("src/main.ts"), "analysis_view");

    class HostileClosurePort extends FixtureClosurePort {
      override async baseRecordClosure(_recordId: string): Promise<DependencyClosureResult> { throw new Error(hostile); }
    }
    const closureSession = captureSession(new CaptureViewPort(undefined, undefined, undefined, { record: baseRecord, completeness }), new HostileClosurePort());
    await closureSession.records.get({ record_type: "base", record_id: "record-base" });
    await assertSafe(closureSession.finalize({}), "dependency_closure");

    const manifest = await emptyLookupManifest();
    class HostileJournalIndex extends InMemoryLookupInvalidationIndex {
      override async journalCoverage(_input: LookupJournalCoverageInput): Promise<LookupJournalCoverageResult> { throw new Error(hostile); }
    }
    await assertSafe(invalidationBinder(new HostileJournalIndex()).bind(bindingInput(manifest)), "lookup_journal");

    class HostilePersistenceIndex extends InMemoryLookupInvalidationIndex {
      override async persistLookupDependencies(_values: readonly BoundPluginLookupInvalidationDependency[]): Promise<void> { throw new Error(hostile); }
    }
    await assertSafe(invalidationBinder(new HostilePersistenceIndex({ artifact_list: ["*"], record_query: ["kind"] })).bind(bindingInput(manifest)), "lookup_persistence");

    const value = captureSession(new CaptureViewPort());
    await value.records.get({ record_type: "base", record_id: "missing-record" });
    const getManifest = (await value.finalize({})).manifest;
    class HostileRevalidationIndex extends InMemoryLookupInvalidationIndex {
      override async currentLookupResult(_dependency: BoundPluginLookupInvalidationDependency): Promise<LookupRevalidationSnapshot> { throw new Error(hostile); }
    }
    const revalidationBinder = invalidationBinder(new HostileRevalidationIndex());
    const [dependency] = await revalidationBinder.bind(bindingInput(getManifest));
    await assertSafe(revalidationBinder.revalidate({ dependencies: [dependency!], generation: 7, cancellation_signal: new AbortController().signal }), "lookup_revalidation");
  });
});

describe("Task 2 bound-port and fulfilled-result boundaries", () => {
  it("binds every analysis-view and closure method at session creation", async () => {
    const viewPort = new FrozenViewPort();
    const closurePort = new EmptyClosurePort();
    const value = createPluginAnalysisSession({
      analysis_view: analysisView,
      view_port: viewPort,
      dependency_closure_port: closurePort,
      cancellation_signal: new AbortController().signal,
      budget: budget(),
      request_id: "request-bound",
      request_digest: "sha256:request-bound",
      plugin_id: "acme:analyzer",
      plugin_version: "1.2.3",
      analysis_digest: "sha256:implementation",
      analysis_configuration_digest: "sha256:analysis-config",
      call: "analyze",
      call_payload: {},
    });
    const replaced = async (): Promise<never> => { throw new Error("REPLACED_SECRET /private/path"); };
    (viewPort as any).listArtifacts = replaced;
    (viewPort as any).findArtifact = replaced;
    (viewPort as any).readArtifact = replaced;
    (viewPort as any).getRecord = replaced;
    (viewPort as any).queryRecords = replaced;
    (closurePort as any).baseRecordClosure = replaced;
    (closurePort as any).stagedRecordClosure = replaced;

    await expect(value.artifacts.list(undefined)).resolves.toHaveLength(2);
    await expect(value.artifacts.find("src/main.ts")).resolves.toEqual(sourceArtifact);
    await expect(value.artifacts.read("artifact-source")).resolves.toBe("export const x=1;");
    await expect(value.records.get({ record_type: "base", record_id: "record-base" })).resolves.toEqual(baseRecord);
    await expect(value.records.get({ record_type: "staged", staged_record_id: "staged-prerequisite" })).resolves.toEqual(stagedRecord);
    await expect(value.records.query({ kind: "acme:route" })).resolves.toHaveLength(2);
    await expect(value.finalize({})).resolves.toMatchObject({ analysis_input_digest: expect.stringMatching(/^sha256:/u) });
  });

  it("binds every invalidation-index method at binder construction", async () => {
    const value = captureSession(new CaptureViewPort());
    await value.records.query({ kind: "acme:missing" });
    const manifest = (await value.finalize({})).manifest;
    const index = new InMemoryLookupInvalidationIndex({ record_query: ["kind"] });
    const binder = invalidationBinder(index);
    const replaced = async (): Promise<never> => { throw new Error("REPLACED_SECRET /private/path"); };
    (index as any).journalCoverage = replaced;
    (index as any).persistLookupDependencies = replaced;
    (index as any).currentLookupResult = replaced;

    const [dependency] = await binder.bind(bindingInput(manifest));
    expect(index.persisted).toEqual([dependency]);
    index.snapshots.set(dependency!.lookup_dependency_id, {
      analysis_view_digest: analysisView.analysis_view_digest,
      completeness,
      results: [],
    });
    await expect(binder.revalidate({ dependencies: [dependency!], generation: 7, cancellation_signal: new AbortController().signal })).resolves.toEqual({
      invalidated_consumer_ids: [], changed_lookup_dependency_ids: [],
    });
  });

  it("sanitizes hostile getters while normalizing fulfilled view and closure results", async () => {
    const hostile = "GETTER_SECRET /Users/private/repository";
    const assertSafe = async (promise: Promise<unknown>, port: string): Promise<void> => {
      let observed: unknown;
      try { await promise; } catch (error) { observed = error; }
      expect(observed).toBeInstanceOf(PluginSdkError);
      expect(observed).toMatchObject({ code: "plugin-sdk:port_failure", details: { port } });
      expect(JSON.stringify((observed as PluginSdkError).toJSON())).not.toContain("GETTER_SECRET");
      expect((observed as Error).message).not.toContain("/Users/private");
    };

    class GetterViewPort extends CaptureViewPort {
      override async listArtifacts(_filter: ArtifactFilter | undefined): Promise<ArtifactLookupResult> {
        return Object.defineProperty({ completeness }, "artifacts", { enumerable: true, get: () => { throw new Error(hostile); } }) as ArtifactLookupResult;
      }
    }
    await assertSafe(captureSession(new GetterViewPort()).artifacts.list(undefined), "analysis_view");

    class GetterClosurePort extends FixtureClosurePort {
      override async baseRecordClosure(_recordId: string): Promise<DependencyClosureResult> {
        return Object.defineProperty({ proof: "proven", staged_records: [], artifact_version_ids: [] }, "base_records", {
          enumerable: true, get: () => { throw new Error(hostile); },
        }) as unknown as DependencyClosureResult;
      }
    }
    const closureSession = captureSession(new CaptureViewPort(undefined, undefined, undefined, { record: baseRecord, completeness }), new GetterClosurePort());
    await closureSession.records.get({ record_type: "base", record_id: "record-base" });
    await assertSafe(closureSession.finalize({}), "dependency_closure");
  });

  it("sanitizes hostile getters while validating fulfilled journal and revalidation results", async () => {
    const hostile = "GETTER_SECRET /Users/private/repository";
    const assertSafe = async (promise: Promise<unknown>, port: string): Promise<void> => {
      let observed: unknown;
      try { await promise; } catch (error) { observed = error; }
      expect(observed).toBeInstanceOf(PluginSdkError);
      expect(observed).toMatchObject({ code: "plugin-sdk:port_failure", details: { port } });
      expect(JSON.stringify((observed as PluginSdkError).toJSON())).not.toContain("GETTER_SECRET");
    };

    const querySession = captureSession(new CaptureViewPort());
    await querySession.records.query({ kind: "acme:missing" });
    const queryManifest = (await querySession.finalize({})).manifest;
    class GetterJournalIndex extends InMemoryLookupInvalidationIndex {
      override async journalCoverage(_input: LookupJournalCoverageInput): Promise<LookupJournalCoverageResult> {
        return Object.defineProperty({}, "journaled_dimensions", { enumerable: true, get: () => { throw new Error(hostile); } }) as LookupJournalCoverageResult;
      }
    }
    await assertSafe(invalidationBinder(new GetterJournalIndex()).bind(bindingInput(queryManifest)), "lookup_journal");

    const getSession = captureSession(new CaptureViewPort());
    await getSession.records.get({ record_type: "base", record_id: "missing-record" });
    const getManifest = (await getSession.finalize({})).manifest;
    class GetterRevalidationIndex extends InMemoryLookupInvalidationIndex {
      override async currentLookupResult(_dependency: BoundPluginLookupInvalidationDependency): Promise<LookupRevalidationSnapshot> {
        return Object.defineProperty({ completeness, results: [] }, "analysis_view_digest", {
          enumerable: true, get: () => { throw new Error(hostile); },
        }) as unknown as LookupRevalidationSnapshot;
      }
    }
    const index = new GetterRevalidationIndex();
    const binder = invalidationBinder(index);
    const [dependency] = await binder.bind(bindingInput(getManifest));
    await assertSafe(binder.revalidate({ dependencies: [dependency!], generation: 7, cancellation_signal: new AbortController().signal }), "lookup_revalidation");
  });
});

describe("Task 2 owned foreign-result snapshots", () => {
  it("preserves special own keys on foreign objects for exact-schema rejection", async () => {
    for (const specialKey of ["__proto__", "constructor", "prototype"] as const) {
      let reads = 0;
      const artifact = Object.defineProperty({ ...sourceArtifact }, specialKey, {
        enumerable: true,
        configurable: false,
        get: () => {
          reads += 1;
          if (reads > 1) throw new Error(`REREAD_${specialKey}_SECRET /private/path`);
          return { injected: specialKey };
        },
      }) as typeof sourceArtifact;
      class SpecialKeyFindPort extends CaptureViewPort {
        override async findArtifact(_uri: string): Promise<ArtifactFindResult> {
          return { artifact, completeness };
        }
      }

      await expect(captureSession(new SpecialKeyFindPort()).artifacts.find("special.ts"))
        .rejects.toMatchObject({ code: "plugin-sdk:analysis_view_invalid" });
      expect(reads).toBe(1);
    }
  });

  it("preserves special own keys on objects nested in foreign arrays", async () => {
    for (const specialKey of ["__proto__", "constructor", "prototype"] as const) {
      let reads = 0;
      const artifact = Object.defineProperty({ ...sourceArtifact }, specialKey, {
        enumerable: true,
        configurable: false,
        get: () => {
          reads += 1;
          if (reads > 1) throw new Error(`ARRAY_REREAD_${specialKey}_SECRET /private/path`);
          return { injected: specialKey };
        },
      }) as typeof sourceArtifact;
      const value = captureSession(new CaptureViewPort({ artifacts: [artifact], completeness }));

      await expect(value.artifacts.list(undefined)).rejects.toMatchObject({ code: "plugin-sdk:analysis_view_invalid" });
      expect(reads).toBe(1);
    }
  });

  it("reads proxy array length once before materializing view results", async () => {
    let lengthReads = 0;
    const artifacts = new Proxy([sourceArtifact], {
      get(target, property, receiver) {
        if (property === "length") {
          lengthReads += 1;
          if (lengthReads > 1) throw new Error("MUTATING_LENGTH_SECRET /private/path");
          return 1;
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const value = captureSession(new CaptureViewPort({ artifacts, completeness }));

    await expect(value.artifacts.list(undefined)).resolves.toEqual([sourceArtifact]);
    expect(lengthReads).toBe(1);
  });

  it("rejects huge proxy lengths before reading any indexed value", async () => {
    let indexedReads = 0;
    const artifacts = new Proxy([], {
      get(target, property, receiver) {
        if (property === "length") return Number.MAX_SAFE_INTEGER;
        if (typeof property === "string" && /^\d+$/u.test(property)) {
          indexedReads += 1;
          throw new Error("HUGE_ARRAY_SECRET /private/path");
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const value = captureSession(new CaptureViewPort({ artifacts, completeness }), new FixtureClosurePort(), {}, budget({ max_memory_bytes: "64" }));

    await expect(value.artifacts.list(undefined)).rejects.toMatchObject({ code: "plugin-sdk:port_failure", details: { port: "analysis_view" } });
    expect(indexedReads).toBe(0);
  });

  it("rejects foreign nesting beyond the contextual recursion budget", async () => {
    let nested: Record<string, unknown> = {};
    for (let depth = 0; depth < 12; depth += 1) nested = { nested };
    class DeepViewPort extends CaptureViewPort {
      override async findArtifact(_uri: string): Promise<ArtifactFindResult> {
        return { completeness, unexpected: nested } as unknown as ArtifactFindResult;
      }
    }
    const value = captureSession(new DeepViewPort(), new FixtureClosurePort(), {}, budget({ max_recursion_depth: "3" }));

    await expect(value.artifacts.find("missing.ts")).rejects.toMatchObject({ code: "plugin-sdk:port_failure", details: { port: "analysis_view" } });
  });

  it("materializes a stateful nested revalidation getter exactly once inside the safe boundary", async () => {
    const hostile = "LATE_GETTER_SECRET /Users/private/repository";
    const value = captureSession(new CaptureViewPort());
    await value.records.get({ record_type: "base", record_id: "missing-record" });
    const manifest = (await value.finalize({})).manifest;
    let reads = 0;
    const statefulResult = Object.defineProperty({ input_type: "base_record", record_id: "record-new" }, "record_digest", {
      enumerable: true,
      get: () => {
        reads += 1;
        if (reads > 1) throw new Error(hostile);
        return "sha256:new";
      },
    });
    class StatefulIndex extends InMemoryLookupInvalidationIndex {
      override async currentLookupResult(_dependency: BoundPluginLookupInvalidationDependency): Promise<LookupRevalidationSnapshot> {
        return { analysis_view_digest: analysisView.analysis_view_digest, completeness, results: [statefulResult as any] };
      }
    }
    const binder = invalidationBinder(new StatefulIndex());
    const [dependency] = await binder.bind(bindingInput(manifest));

    const result = await binder.revalidate({ dependencies: [dependency!], generation: 7, cancellation_signal: new AbortController().signal });
    expect(result.invalidated_consumer_ids).toEqual(["partition-1"]);
    expect(reads).toBe(1);
  });

  it("sanitizes a hostile exported PluginSdkError thrown by a foreign fulfilled-result getter", async () => {
    const hostile = "PLUGIN_ERROR_SECRET /Users/private/repository";
    class HostileSdkErrorGetterPort extends CaptureViewPort {
      override async listArtifacts(_filter: ArtifactFilter | undefined): Promise<ArtifactLookupResult> {
        return Object.defineProperty({ completeness }, "artifacts", {
          enumerable: true,
          get: () => { throw new PluginSdkError("plugin-sdk:analysis_view_invalid", hostile, { leaked: hostile }); },
        }) as ArtifactLookupResult;
      }
    }
    let observed: unknown;
    try { await captureSession(new HostileSdkErrorGetterPort()).artifacts.list(undefined); }
    catch (error) { observed = error; }

    expect(observed).toBeInstanceOf(PluginSdkError);
    expect(observed).toMatchObject({ code: "plugin-sdk:port_failure", details: { port: "analysis_view" } });
    expect(JSON.stringify((observed as PluginSdkError).toJSON())).not.toContain("PLUGIN_ERROR_SECRET");
    expect((observed as Error).message).not.toContain("/Users/private");
  });
});
