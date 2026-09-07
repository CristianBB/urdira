export { EngineError } from "./errors.js";
export { mapWithConcurrency } from "./concurrency.js";
// Canonical bytes/digests are a core-owned authority. Re-exporting the narrow
// primitives keeps the composed application from importing the canonical
// package directly while building private Rust-engine envelopes.
export { canonicalBytes, digestBytes } from "@urdira/canonical";
// Re-exported so a composing application (`apps/urdira`) can record its OWN
// sub-buckets into the exact same `URDIRA_STORAGE_DEBUG_TIMING`-gated bucket
// map `workspace-indexing-session.ts` snapshots/logs as "engine timings" --
// see `record`'s doc comment (`debug-timing.ts`) and P3-3c (docs) for why
// this is the only way to attribute work that happens INSIDE a plugin's own
// `analyze()` implementation, which engine cannot see into.
export { record as recordEngineTiming, timingEnabled as engineTimingEnabled } from "./debug-timing.js";
export { createCanonicalPluginDigestAuthority } from "./plugin-digest-authority.js";
export { candidateTargetRegistryFromSnapshot } from "./candidate-target-registry.js";
export {
  CanonicalRecordQueryDataPort,
  SqliteCanonicalQuerySnapshotPort,
  type CanonicalQueryRecord,
  type CanonicalQuerySnapshotPort,
  type IndexedGraphEdge,
} from "./canonical-query-data-port.js";
export { decodeRow as decodeCanonicalQueryRecordRow, type RecordRow as CanonicalQueryRecordRow } from "./query-record-decode.js";
export { NativeCanonicalQuerySnapshotPort } from "./native-query-snapshot-port.js";
export { convertV3WorkspaceToNativeStore, type ConvertV3WorkspaceToNativeStoreOptions, type ConvertV3WorkspaceToNativeStoreResult } from "./native-store-convert.js";
export { loadNativeStructuralStoreAddon, resetNativeStructuralStoreAddonCacheForTests, type NativeStructuralStoreAddon } from "./native-structural-store-binding.js";
export {
  onRustWorkspaceUpgradeCompleted,
  runRustWorkspaceScan,
  type ChangedPath,
  type ChangedPathKind,
  type ReconcileMode,
  type ReconcileSummary,
  type RustWorkspaceScanOutcome,
  type RustWorkspaceScanTransport,
  type ScanPriority,
  type ScanRoots,
  type ScanScope,
  type ScanTimings,
  type WorkspaceScanQueryable,
  type WorkspaceScanRequest,
  type WorkspaceScanResult,
  type WorkspaceScanUpgradeCompleted,
} from "./rust-workspace-scan.js";
export {
  ensureV4Workspace,
  sidecarDatabasePathFor,
  sidecarScanDirFor,
  structuralStoreDirFor,
  type EnsureV4WorkspaceInput,
  type V4WorkspacePaths,
} from "./workspace-v4-bootstrap.js";
export { RecordBodyInterner } from "./record-body-interner.js";
export {
  classifyWorkspaceConfigurationImpact,
  detectWorkspaceTechnologies,
  summarizeWorkspaceTechnologyProposal,
  WorkspaceConfigurationCoordinator,
  type WorkspaceConfigurationImpact,
  type WorkspaceConfigurationAttemptRecord,
  type WorkspaceConfigurationCoordinatorOptions,
  type WorkspaceDetectionFile,
  type WorkspaceDetectionInput,
  type WorkspaceTechnologyEvidence,
  type WorkspaceTechnologyKind,
  type WorkspaceTechnologyProposal,
  type WorkspaceTechnologyProposalItem,
  type WorkspaceTechnologyProposalSummary,
  type WorkspaceTechnologyProposalSummaryItem,
  type WorkspacePluginCatalogEntry,
  type WorkspaceConfigurationProposal,
} from "./workspace-configuration.js";
export { CursorCache, CursorCacheError, type CursorCacheOptions, type CursorDirection, type ManifestStreamReader, type ManifestStreamReadRequest, type ManifestStreamReadResult, type QueryCursorClaims, type ReadPageRequest, type ReadPageResult } from "./cursor-cache.js";
export { evaluateOperation, expandRelations, findShortestPaths, type EvaluateOperationInput, type ExpandedRelation, type OperationEvaluation, type OperationInvocation, type QueryDataPort, type QueryStreamItem, type RelationEdge, type RelationExpansionOptions, type ShortestPath, type ShortestPathOptions } from "./query-operators.js";
export {
  DurableManifestStore,
  MemoryManifestStore,
  QueryEngine,
  QueryOperationTelemetry,
  type QueryContinuationRequest,
  type QueryExecutionOptions,
  type QueryExecutionPage,
  type QueryManifestStore,
  type QueryMetricDistribution,
  type QueryOperationMetric,
  type QueryOperationMetricProbe,
  type QueryOperationResourceMeasurement,
  type QueryOperationTelemetrySummary,
  type QueryStreamPage,
} from "./query-execution.js";
export { buildQueryAdmissionPlan, normalizeQueryRequest, validatePipelineExpression, QueryPlanError, type NormalizedQueryPlan, type QueryAdmissionPlan, type QueryFrontier } from "./query-plan.js";
export { stageSetHandle, type StageSetHandle } from "./stage-set-handle.js";
export { MemoryStageSpool, SqliteStageSpool, DEFAULT_HARD_BYTES, DEFAULT_SPILL_BYTES, type StageSpool, type StageSpoolLimits } from "./pipeline-spool.js";
export {
  DeterministicFakeWatcher,
  ParcelWatcherAdapter,
  watcherOptionsForSourceProvider,
  type ParcelWatcherAdapterOptions,
  type ParcelWatcherBackend,
  type PhysicalWatcherEvent,
  type WatcherBatchHandler,
  type WatcherBinding,
  WorkspaceWatcherManager,
  type WorkspaceWatcherBinding,
  type WorkspaceWatcherManagerOptions,
  type WatcherEventClass,
  type WatcherHint,
  type WatcherHintBatch,
  type WatcherReconcileReason,
  type WatcherSubscription,
} from "./watchers.js";
export {
  FreshnessBarrier,
  ReconciliationCoordinator,
  SYSTEM_RECONCILIATION_CLOCK,
  type FreshnessBarrierOptions,
  type FreshnessBarrierPort,
  type FreshnessBindingRequest,
  type FreshnessCheckpoint,
  type FreshnessCheckpointWatermark,
  type FreshnessOperationContext,
  type FreshnessSnapshotBinding,
  type FreshnessTargetWatermark,
  type FreshnessWorkspaceTarget,
  type ReconciliationClock,
  type ReconciliationCommit,
  type ReconciliationCommitOutcome,
  type ReconciliationCoordinatorOptions,
  type ReconciliationKind,
  type ReconciliationPort,
  type ReconciliationRequest,
  type ReconciliationResult,
  type ReconciliationTrigger,
  type SourceBarrierStateUpdate,
  type SourceBarrierStatus,
  type TimerHandle,
} from "./reconciliation.js";
export {
  DirectorySourceProvider,
  DEFAULT_WORKSPACE_INCLUSION,
  NODE_DIRECTORY_FILE_SYSTEM,
  type DirectoryEntry,
  type DirectoryFileStat,
  type DirectoryFileSystem,
  type DirectorySourceProviderOptions,
  type EncodedObservationBatch,
  type ProviderObservation,
} from "./directory-provider.js";
export {
  sourceProviderRequestDigest,
  type SourceProvider,
  type SourceProviderCall,
  type SourceProviderOutcome,
  type SourceProviderRequestExpectations,
} from "./source-provider.js";
export {
  GitReferenceSourceProvider,
  GitWorktreeSourceProvider,
  ISOMORPHIC_GIT_OBJECT_PORT,
  administrativeState,
  peeledHeadFor,
  type GitAdministration,
  type GitObjectPort,
  type GitPeeledHead,
  type GitReferenceSourceProviderOptions,
  type GitWorktreeSourceProviderOptions,
} from "./git-providers.js";
export {
  WorkspaceRegistry,
  resolveWorkspaceRoot,
  resolveIndexStatusRequest,
  type RegisteredCodebase,
  type RegisteredWorkspace,
  type SourceProviderBindingInput,
  type SourceProviderDescription,
  type WorkspaceRegistration,
  type WorkspaceReconciliationOperation,
  type WorkspaceReconciliationResult,
  type WorkspaceRegistryPersistence,
  type WorkspaceRegistryOptions,
  type WorkspaceRegistryState,
  type WorkspaceRootResolution,
  type WorkspaceIndexStatusResolution,
  type WorkspaceRelocation,
  type WorkspaceStatus,
} from "./workspaces.js";
export { GenericSourceIndexer, type SourceIndexApplyInput, type SourceIndexApplyResult, type SourceIndexWorkspacePort } from "./source-indexer.js";
export { reconcileLexicalProjection, type LexicalReconcilerContentReader, type ReconcileLexicalProjectionInput, type ReconcileLexicalProjectionResult } from "./lexical-reconciler.js";
export {
  SourceCandidatePlanner,
  type CandidateSeedChange,
  type SourceCandidateBase,
  type SourceCandidateObservation,
  type SourceCandidateObservationSet,
  type SourceCandidatePlan,
  type SourceCandidatePresentObservation,
} from "./source-candidate-planning.js";
export { sourceObservationBatchDigest } from "./source-batch-digest.js";
export {
  CandidatePlanner,
  buildCandidateExecutionDag,
  executeCandidateDag,
  type AcceptedWorkResult,
  type BaseCandidateProjection,
  type BaseCandidateRecord,
  type CandidateExecutionDag,
  type CandidateInvalidationPathStep,
  type CandidateLookupRevalidationSnapshot,
  type CandidatePlan,
  type CandidatePlannerInput,
  type CandidatePlanningSeedChange,
  type CandidatePlanningWorkItem,
  type ExpandedAffectedArtifactEntry,
  type ExpandedAffectedProjectionEntry,
  type ExpandedAffectedRecordEntry,
  type ExpandedInvalidationPlan,
  type FrozenCandidateBaseTuple,
  type LookupRevalidationDecision,
  type ProjectionDependencyEntry,
  type WorkPrerequisite,
} from "./candidate-planning.js";
export {
  FactDeltaAcceptanceService,
  FactDeltaStreamAcceptanceService,
  CandidateDeltaError,
  validateFactDelta,
  type AcceptedDeltaStore,
  type AcceptedFactDelta,
  type MaterializationAcceptedFactDelta,
  type MaterializationProposedRecord,
  compactAcceptedFactDelta,
  type CandidateTargetRegistry,
  type FactDeltaValidationInput,
  type RegisteredRecordKind,
  type ValidatedFactDelta,
  type ValidatedReplacementSet,
  type ValidatedStagedRecord,
  type RegisteredArtifactVersion,
  type DependencyClosureEntry,
} from "./fact-delta.js";
export {
  buildFactDeltaBatch,
  factDeltaBatchTransferList,
  readArenaString,
  validateFactDeltaBatch,
  FACT_DELTA_BATCH_MAX_BYTES,
  FACT_DELTA_BATCH_MAX_ROWS,
  FACT_DELTA_BATCH_PROTOCOL_VERSION,
  type FactDeltaBatch,
  type FactDeltaBatchRow,
  type FactDeltaColumnBatch,
  type Utf8Arena,
} from "./fact-delta-batch.js";
export {
  CandidateExecutor,
  CandidateExecutionError,
  type CandidateAnalysisContextPort,
  type CandidateValidationPort,
  type AcceptedManifestPersistencePort,
  type AcceptedManifestPersistenceKey,
  type AcceptedManifestPersistenceRecord,
  type CandidateProjectionValidationContext,
  type CandidateExecutionInput,
  type CandidateWorkerPort,
} from "./candidate-execution.js";
export {
  CandidateMaterializer,
  CandidateMaterializationError,
  CandidateRecordTemplateAccumulator,
  type CandidateAbsenceBarrier,
  type CandidateKnownArtifactVersion,
  type CandidateLookupDependencyAuthority,
  type CandidateRecordDependencyTemplate,
  type CandidateRecordOpenMemoEntry,
  type CandidateLookupBindingTemplate,
  type CandidateProjectionDependencyTemplate,
  type CandidateMaterializationInput,
  type CandidateMaterializerOptions,
  type SealedCandidateMaterialization,
  type ValidatedProjectionReplacementSet,
} from "./candidate-materialization.js";
export { MaterializationDigestOffload } from "./materialization-digest-offload.js";
export {
  configureNativeLogicalDigestPort,
  digestNativeLogicalValueBatch,
  verifyNativeLogicalValueBatch,
  type NativeLogicalDigestPort,
  type NativeLogicalDigestResult,
  type NativeLogicalValueDigestInput,
  type NativeLogicalValueVerificationInput,
  type NativeLogicalVerificationResult,
} from "./native-logical-digest.js";
export {
  CandidateIndexer,
  createCandidateIssue,
  type CandidateCleanupResource,
  type CandidateIndexerOptions,
  type CandidateIssueInput,
  type CandidateIssuePort,
  type CandidatePublicationResult,
  type CandidateRunResult,
  type CandidateRunTrigger,
  type CandidateState,
  type CandidateStatePort,
  type CandidateWorkspacePort,
  type StageSourceBatchInput,
  type StagedSourceBatch,
} from "./candidate-indexer.js";
export { createWorkspaceCandidatePort } from "./workspace-indexing-port.js";
export {
  validateIndexGenerationRequest,
  type IndexGenerationRequest,
  type IndexingProgress,
  type IndexingResult,
  type RustIndexingCoreClient,
  type RustIndexingCoreGenerationPort,
} from "./rust-indexing-core-port.js";
export {
  runFullWorkspaceScan,
  runProgressiveWorkspaceScan,
  runSourceOnlyWorkspaceScan,
  type RunFullWorkspaceScanInput,
  type RunSourceOnlyWorkspaceScanInput,
  type SourceOnlyWorkspaceScanResult,
  type WorkspaceScanBudget,
  type WorkspaceScanAnalysisOutcome,
  type WorkspaceScanPluginProvider,
  type WorkspaceScanSourceArtifact,
} from "./workspace-indexing-session.js";
export {
  attemptWorkspaceFork,
  type WorkspaceForkOptions,
  type WorkspaceForkOutcome,
} from "./workspace-fork.js";
export {
  attemptIndexPackImport,
  exportIndexPack,
  exportV4IndexPack,
  importV4IndexPack,
  IndexPackExportRaceError,
  INDEX_PACK_SCHEMA_VERSION,
  V4_INDEX_PACK_FORMAT,
  V4_INDEX_PACK_SCHEMA_VERSION,
  type ExportIndexPackOptions,
  type ExportIndexPackResult,
  type ExportV4IndexPackOptions,
  type ImportV4IndexPackOptions,
  type ImportV4IndexPackResult,
  type IndexPackCompatibility,
  type IndexPackImportOptions,
  type IndexPackImportOutcome,
  type IndexPackManifest,
  type IndexPackRowCounts,
  type IndexPackSnapshotAnchor,
  type V4IndexPackFileEntry,
  type V4IndexPackManifest,
} from "./index-pack.js";
export {
  readPersistedControlState,
  readPersistedRegistrySnapshot,
} from "./plugin-resolution-continuity.js";
export {
  buildSemanticDocument,
  type SemanticDocument,
  type SemanticDocumentEnrichment,
  type SemanticDocumentInput,
  type SemanticDocumentSection,
} from "./semantic-documents.js";
export {
  DeterministicSemanticRuntime,
  DeterministicOnnxInferencePort,
  CoreDocumentRenderer,
  CoreQueryRenderer,
  CoreSegmenter,
  CoreTokenizer,
  SemanticRuntimeRegistry,
  canonicalVectorBytes,
  segmentByChars,
  CHARS_PER_TOKEN_ESTIMATE,
  DEFAULT_MAX_SEGMENTS,
  DEFAULT_SEGMENT_OVERLAP_TOKENS,
  DEFAULT_SEGMENT_WINDOW_TOKENS,
  type DeterministicSemanticRuntimeOptions,
  type GenerateVectorInput,
  type SegmentByCharsOptions,
  type SegmentSpan,
  type Segmentation,
  type SemanticGenerateInput,
  type SemanticGeneratedVector,
  type SemanticInferenceInput,
  type SemanticInferencePort,
  type SemanticRendererPort,
  type SemanticRuntimeBinding,
  type SemanticVectorConfiguration,
} from "./semantic-runtime.js";
export {
  exactVectorScan,
  fuseSemanticLanes,
  rerankSemanticMatches,
  type ExactVectorCandidate,
  type ExactVectorMatch,
  type ExactVectorScanOptions,
  type FusedSemanticCandidate,
  type Rational,
  type RankedSemanticCandidate,
  type SemanticLaneRanks,
  type SemanticMetadata,
  type SemanticRerankOptions,
  type SemanticSearchResult,
} from "./semantic-retrieval.js";
export {
  configureNativeExactVectorTopKPort,
  nativeExactVectorTopK,
  nativeExactVectorTopKConfigured,
  type NativeExactVectorTopKMatch,
  type NativeExactVectorTopKPort,
  type NativeExactVectorTopKRequest,
} from "./native-exact-vector.js";
export { selectBundledProfile, type BundledProfileCandidate, type FrozenEvaluationGate } from "./semantic-selection.js";
export {
  createHttpEmbeddingProvider,
  createLocalHashProvider,
  HttpEmbeddingProviderUnavailableError,
  segmenterIdentity,
  type HttpEmbeddingProviderOptions,
  type ResolvedSemanticProvider,
} from "./semantic-provider.js";
export {
  reconcileSemanticProjection,
  semanticMaterializationIdentity,
  semanticVectorProjectionRecordId,
  decodeEntityRecordBody,
  evaluateEntityEligibility,
  leadingDocComment,
  renderEntityDocument,
  DEFAULT_MIN_ENTITY_SPAN_LENGTH,
  INELIGIBLE_ENTITY_RECORD_KIND,
  INELIGIBLE_ENTITY_BODY_KINDS,
  type EntityEligibility,
  type SemanticReconcilerContentReader,
  type ReconcileSemanticProjectionInput,
  type ReconcileSemanticProjectionResult,
  type SemanticEntityCandidateRow,
  type SemanticEntityRecordSource,
} from "./semantic-reconciler.js";
export { createNativeSemanticEntityRecordSource, type EntityScanPort } from "./semantic-entity-source-v4.js";
export {
  SemanticUpdater,
  type SemanticCoverageStatus,
  type SemanticLaneMaterialization,
  type SemanticLaneVector,
  type SemanticMaterialization,
  type SemanticMaterializationStore,
  type SemanticProfileLane,
  type SemanticRuntimeProvider,
  type SemanticUpdateInput,
} from "./semantic-updater.js";
