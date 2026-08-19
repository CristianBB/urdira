export { EngineError } from "./errors.js";
export { mapWithConcurrency } from "./concurrency.js";
export { createCanonicalPluginDigestAuthority } from "./plugin-digest-authority.js";
export { candidateTargetRegistryFromSnapshot } from "./candidate-target-registry.js";
export {
  CanonicalRecordQueryDataPort,
  SqliteCanonicalQuerySnapshotPort,
  type CanonicalQueryRecord,
  type CanonicalQuerySnapshotPort,
} from "./canonical-query-data-port.js";
export { RecordBodyInterner } from "./record-body-interner.js";
export {
  classifyWorkspaceConfigurationImpact,
  detectWorkspaceTechnologies,
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
  type WorkspacePluginCatalogEntry,
  type WorkspaceConfigurationProposal,
} from "./workspace-configuration.js";
export { CursorCache, CursorCacheError, type CursorCacheOptions, type CursorDirection, type ManifestStreamReader, type ManifestStreamReadRequest, type ManifestStreamReadResult, type QueryCursorClaims, type ReadPageRequest, type ReadPageResult } from "./cursor-cache.js";
export { evaluateOperation, expandRelations, findShortestPaths, type EvaluateOperationInput, type ExpandedRelation, type OperationEvaluation, type OperationInvocation, type QueryDataPort, type QueryStreamItem, type RelationEdge, type RelationExpansionOptions, type ShortestPath, type ShortestPathOptions } from "./query-operators.js";
export { DurableManifestStore, MemoryManifestStore, QueryEngine, type QueryContinuationRequest, type QueryExecutionOptions, type QueryExecutionPage, type QueryManifestStore, type QueryStreamPage } from "./query-execution.js";
export { normalizeQueryRequest, validatePipelineExpression, QueryPlanError, type NormalizedQueryPlan } from "./query-plan.js";
export {
  DeterministicFakeWatcher,
  ParcelWatcherAdapter,
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
  CandidateDeltaError,
  validateFactDelta,
  type AcceptedDeltaStore,
  type AcceptedFactDelta,
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
  type CandidateAbsenceBarrier,
  type CandidateKnownArtifactVersion,
  type CandidateLookupDependencyAuthority,
  type CandidateRecordDependencyTemplate,
  type CandidateLookupBindingTemplate,
  type CandidateProjectionDependencyTemplate,
  type CandidateMaterializationInput,
  type CandidateMaterializerOptions,
  type SealedCandidateMaterialization,
  type ValidatedProjectionReplacementSet,
} from "./candidate-materialization.js";
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
  type DeterministicSemanticRuntimeOptions,
  type GenerateVectorInput,
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
export { selectBundledProfile, type BundledProfileCandidate, type FrozenEvaluationGate } from "./semantic-selection.js";
export {
  createHttpEmbeddingProvider,
  createLocalHashProvider,
  type HttpEmbeddingProviderOptions,
  type ResolvedSemanticProvider,
} from "./semantic-provider.js";
export {
  reconcileSemanticProjection,
  semanticMaterializationIdentity,
  semanticVectorProjectionRecordId,
  type SemanticReconcilerContentReader,
  type ReconcileSemanticProjectionInput,
  type ReconcileSemanticProjectionResult,
} from "./semantic-reconciler.js";
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
