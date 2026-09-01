export type NativeAccelerationControllerLane = "baseline" | "candidate";
export type NativeAccelerationMutationCategory = "content" | "import" | "create" | "delete" | "rename" | "tsconfig" | "manifest";

export interface NativeAccelerationWriteChange {
  readonly kind: "write";
  readonly path: string;
  readonly before_digest: string | null;
  readonly after_digest: string;
  readonly content_base64: string;
}

export interface NativeAccelerationDeleteChange {
  readonly kind: "delete";
  readonly path: string;
  readonly before_digest: string;
}

export interface NativeAccelerationRenameChange {
  readonly kind: "rename";
  readonly from_path: string;
  readonly to_path: string;
  readonly content_digest: string;
}

export type NativeAccelerationMutationChange = NativeAccelerationWriteChange | NativeAccelerationDeleteChange | NativeAccelerationRenameChange;

export interface NativeAccelerationMutation {
  readonly mutation_index: number;
  readonly mutation_id: string;
  readonly category: NativeAccelerationMutationCategory;
  readonly changes: readonly NativeAccelerationMutationChange[];
  readonly resulting_corpus_digest: string;
}

export interface NativeAccelerationMutationTrace {
  readonly schema_version: 1;
  readonly trace_id: string;
  readonly base_corpus_digest: string;
  readonly excluded_paths: readonly string[];
  readonly mutations: readonly NativeAccelerationMutation[];
}

export interface NativeAccelerationControllerConfig {
  readonly schema_version: 2;
  readonly lane: NativeAccelerationControllerLane;
  readonly corpus_path: string;
  readonly mutation_trace_path: string;
  readonly data_root: string;
  readonly runtime_module: string;
  readonly workspace_selection: {
    readonly selected_technology_ids: readonly string[];
    readonly selected_plugin_ids: readonly string[];
  };
  readonly qualification: {
    readonly mode: "qualifying";
    readonly corpus_tier: "L";
    readonly cache_state: "cold";
    readonly applied_limits: {
      readonly max_indexing_cores: 6;
      readonly max_rss_bytes: 8589934592;
    };
    readonly capture_phase_timings: true;
  };
  readonly polling: {
    readonly interval_ms: number;
    readonly readiness_timeout_ms: number;
  };
}

export interface NativeAccelerationCorpusState {
  readonly entries: Map<string, { readonly path: string; readonly kind: "file" | "symlink"; readonly digest: string }>;
  digest: string;
  nextMutationIndex: number;
}

export interface NativeAccelerationControllerRequestBase {
  readonly schema_version: 2;
  readonly request_id: string;
  readonly campaign_id: string;
  readonly lane: NativeAccelerationControllerLane;
  readonly target: string;
  readonly corpus_path: string;
  readonly corpus_digest: string;
  readonly mutation_trace_digest: string;
}

export type NativeAccelerationControllerRequest =
  | (NativeAccelerationControllerRequestBase & { readonly operation: "prepare" | "cold_index" | "shutdown" })
  | (NativeAccelerationControllerRequestBase & { readonly operation: "incremental_mutation"; readonly mutation_index: number });

export type NativeAccelerationColdPhase = "runtime_load" | "daemon_start" | "workspace_add" | "readiness" | "digest";
export type NativeAccelerationIncrementalPhase = "mutation_apply" | "readiness" | "digest";

export interface NativeAccelerationPhaseTimings<TPhase extends string> {
  readonly unit: "milliseconds";
  readonly phases: readonly {
    readonly phase: TPhase;
    readonly duration_ms: number;
  }[];
  readonly total_duration_ms: number;
}

export interface NativeAccelerationControllerResponseBase {
  readonly schema_version: 2;
  readonly request_id: string;
  readonly status: "ok";
}

export type NativeAccelerationPrepareResponse = NativeAccelerationControllerResponseBase & {
  readonly corpus_digest: string;
  readonly mutation_trace_digest: string;
};

export type NativeAccelerationColdIndexResponse = NativeAccelerationControllerResponseBase & {
  readonly phase_timings: NativeAccelerationPhaseTimings<NativeAccelerationColdPhase>;
  readonly visible_set_digest: string;
};

export type NativeAccelerationIncrementalMutationResponse = NativeAccelerationControllerResponseBase & {
  readonly phase_timings: NativeAccelerationPhaseTimings<NativeAccelerationIncrementalPhase>;
  readonly mutation_index: number;
  readonly visible_set_digest: string;
};

export type NativeAccelerationShutdownResponse = NativeAccelerationControllerResponseBase;
export type NativeAccelerationControllerResponse = NativeAccelerationPrepareResponse | NativeAccelerationColdIndexResponse | NativeAccelerationIncrementalMutationResponse | NativeAccelerationShutdownResponse;

export type NativeAccelerationControllerResponseFor<TRequest extends NativeAccelerationControllerRequest> =
  TRequest["operation"] extends "prepare" ? NativeAccelerationPrepareResponse
    : TRequest["operation"] extends "cold_index" ? NativeAccelerationColdIndexResponse
      : TRequest["operation"] extends "incremental_mutation" ? NativeAccelerationIncrementalMutationResponse
        : NativeAccelerationShutdownResponse;

export interface NativeAccelerationController {
  readonly config: NativeAccelerationControllerConfig;
  readonly trace: NativeAccelerationMutationTrace;
  readonly mutationTraceDigest: string;
  readonly workspaceId?: string;
  readonly snapshotId?: string;
  status(previousSnapshotId?: string): Promise<Record<string, unknown>>;
  handle<const TRequest extends NativeAccelerationControllerRequest>(request: TRequest): Promise<NativeAccelerationControllerResponseFor<TRequest>>;
  dispose(): Promise<void>;
}

export function nativeAccelerationMutationTraceDigest(bytes: Uint8Array): string;
export function nativeAccelerationControllerConfigDigest(bytes: Uint8Array): string;
export function validateNativeAccelerationMutationTrace(value: unknown): NativeAccelerationMutationTrace;
export function validateNativeAccelerationControllerConfig(value: unknown): NativeAccelerationControllerConfig;
export function loadNativeAccelerationCorpusState(root: string, excludedPaths: readonly string[]): Promise<NativeAccelerationCorpusState>;
export function computeNativeAccelerationCorpusDigest(root: string, excludedPaths: readonly string[]): Promise<string>;
export function applyNativeAccelerationMutation(root: string, state: NativeAccelerationCorpusState, mutation: NativeAccelerationMutation): Promise<string>;
export function readNativeAccelerationVisibleSetDigest(dataRoot: string, workspaceId: string, snapshotId: string): Promise<string>;
export function createNativeAccelerationController(config: unknown): Promise<NativeAccelerationController>;
export function runNativeAccelerationControllerCli(argv: readonly string[], io?: { readonly stdin?: NodeJS.ReadableStream; readonly stdout?: Pick<NodeJS.WriteStream, "write"> }): Promise<void>;
