export type NativeAccelerationLane = "baseline" | "candidate";
export type NativeAccelerationCorpusTier = "S" | "M" | "L";

export interface NativeAccelerationCommandManifest {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
}

export interface NativeAccelerationLaneProvenanceManifest {
  readonly revision: string;
  readonly build_id: string;
  readonly configuration_digest: string;
  readonly controller_executable_digest: string;
  readonly runtime_module_digest: string;
  readonly cargo_lock_digest: string;
  readonly native_manifest_digest: string | null;
  readonly native_closure_digest: string | null;
}

export interface NativeAccelerationCampaignManifest {
  readonly schema_version: 2;
  readonly campaign_id: string;
  readonly target: string;
  readonly corpus: {
    readonly digest: string;
    readonly mutation_trace_digest: string;
    readonly baseline_path: string;
    readonly candidate_path: string;
  };
  readonly sample_count: 60;
  readonly execution_order: readonly [NativeAccelerationLane, NativeAccelerationLane];
  readonly rss_sample_interval_ms: number;
  readonly qualification: {
    readonly cache_state: "cold";
    readonly cache_preparation: string;
    readonly background_load: string;
    readonly resource_limits: {
      readonly cpu_cores: 6;
      readonly memory_bytes: 8589934592;
      readonly enforcement: string;
    };
  };
  readonly timeouts: {
    readonly prepare_ms: number;
    readonly cold_index_ms: number;
    readonly mutation_ms: number;
    readonly shutdown_ms: number;
  };
  readonly lanes: Readonly<Record<NativeAccelerationLane, {
    readonly command: NativeAccelerationCommandManifest;
    readonly provenance: NativeAccelerationLaneProvenanceManifest;
  }>>;
}

export interface NativeAccelerationCorpusCoordinates {
  readonly included_files: number;
  readonly logical_source_lines: number;
  readonly included_source_bytes: number;
}

export interface NativeAccelerationFileEvidence {
  readonly path: string;
  readonly digest: string;
  readonly byte_length: number;
}

export interface NativeAccelerationRssEvidence extends NativeAccelerationFileEvidence {
  readonly sample_count: number;
}

export interface NativeAccelerationLaneResult {
  readonly cold_index_ms: number;
  readonly incremental_times_ms: readonly number[];
  readonly visible_set_digests: readonly string[];
  readonly incremental_p95_ms: number;
  readonly peak_process_tree_rss_bytes: number;
  readonly raw_evidence: {
    readonly stderr_log: NativeAccelerationFileEvidence;
    readonly protocol_log: NativeAccelerationFileEvidence;
    readonly rss_series: NativeAccelerationRssEvidence;
  };
}

export interface NativeAccelerationCampaignResult {
  readonly campaign_id: string;
  readonly target: string;
  readonly execution_order: readonly [NativeAccelerationLane, NativeAccelerationLane];
  readonly corpus: NativeAccelerationCorpusCoordinates & { readonly tier: NativeAccelerationCorpusTier };
  readonly host: {
    readonly run_id: string;
    readonly hostname: string;
    readonly platform: string;
    readonly release: string;
    readonly architecture: string;
    readonly cpu_model: string;
    readonly physical_cpu_count: number;
    readonly logical_cpu_count: number;
    readonly total_memory_bytes: number;
    readonly filesystem_type: string;
    readonly storage_class: string;
    readonly node: string;
    readonly sqlite: string;
    readonly cache_state: "cold";
    readonly max_indexing_cores: 6;
    readonly max_indexing_rss_bytes: 8589934592;
  };
  readonly baseline: NativeAccelerationLaneResult;
  readonly candidate: NativeAccelerationLaneResult;
  readonly provenance: {
    readonly corpus_digest: string;
    readonly mutation_trace_digest: string;
    readonly manifest_digest: string;
    readonly runtime_module_digest: string;
    readonly controller_config_digests: Readonly<Record<NativeAccelerationLane, string>>;
    readonly controller_executable_digests: Readonly<Record<NativeAccelerationLane, string>>;
    readonly cargo_lock_digest: string;
    readonly native_closure_digest: string;
  };
}

export interface NativeAccelerationCampaignReport {
  readonly schema_version: 2;
  readonly generated_at: string;
  readonly harness: {
    readonly name: "run-native-acceleration-campaign";
    readonly version: 2;
    readonly controller_protocol: "urdira.native-acceleration-controller.v2";
    readonly runner_digest: string;
  };
  readonly campaigns: readonly NativeAccelerationCampaignResult[];
  readonly report_digest: string;
}

export function classifyNativeAccelerationCorpusTier(coordinates: NativeAccelerationCorpusCoordinates): NativeAccelerationCorpusTier;
export function currentNativeAccelerationTarget(): string;
export function validateNativeAccelerationCampaignManifest(value: unknown): NativeAccelerationCampaignManifest;
export function runNativeAccelerationCampaign(
  manifest: unknown,
  options: {
    readonly manifestPath: string;
    readonly reportPath: string;
    readonly manifestBytes: Uint8Array;
    readonly append?: boolean;
  },
): Promise<NativeAccelerationCampaignReport>;
