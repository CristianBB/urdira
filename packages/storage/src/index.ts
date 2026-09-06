export { StorageError } from "./errors.js";
export { ByteBoundaryTelemetry, type ByteBoundary, type ByteTelemetrySnapshot } from "./byte-telemetry.js";
export { BlobStore, ContentAddressedStore, type BlobReference, type CasPutOptions, type CasPutStreamOptions } from "./cas.js";
export { SqliteWorkerAdapter, openSqliteDatabase, type OpenSqliteOptions, type SqliteCommand, type SqliteDatabase, type SqliteRunResult, type SqliteValue } from "./sqlite.js";
export { CATALOG_SCHEMA, WORKSPACE_SCHEMA, ensureCatalogSchemaCompatibility, ensureWorkspaceSchemaCompatibilityV4, readStructuralStore, STRUCTURAL_STORE_META_KEY, WORKSPACE_V4_INDEX_CONTRACT, writeStructuralStore } from "./schema.js";
export { WORKSPACE_V3_SCHEMA, WORKSPACE_V3_SCHEMA_DIGEST, assertWorkspaceV3SchemaDigest } from "./workspace-v3-sql.js";
export { WORKSPACE_V4_LEXICAL_SCHEMA, WORKSPACE_V4_SCHEMA, WORKSPACE_V4_SEMANTIC_SCHEMA } from "./workspace-v4-sql.js";
export { PUBLICATION_SQL, PUBLICATION_V3_SQL_DIGEST } from "./publication-v3-sql.js";
export { inspectV3DataRoot, migrateToV3, type LegacyMigrationWorkspacePreview, type V3MigrationPreview } from "./v3-migration.js";
export { isOutdatedWorkspaceError, recreateOutdatedWorkspaceDatabase, type RecreateOutdatedWorkspaceDatabaseInput, type RecreateOutdatedWorkspaceDatabaseResult } from "./recreate-outdated.js";
export { removeWorkspaceFootprint, workspaceFootprintEntries, WORKSPACE_FOOTPRINT_SUFFIXES, type WorkspaceFootprintEntry, type WorkspaceFootprintEntryKind } from "./workspace-footprint.js";
export { PersistentSparseMerkleSet } from "./merkle-store.js";
export { CanonicalOccurrenceRepository, ControlPlaneRepository, RegistryRepository, SnapshotRepository, SourceCatalogRepository, type ArtifactTombstoneRecord, type ArtifactVersionRecord, type ClosedIdentityRecord, type SourceObservationBatchRecord, type SourceObservationRecord, type WorkspaceRepositories, type WorkspaceVisibleRecord } from "./repositories.js";
export { DurableStorage, InstallationCatalog, SerializedSqliteDatabase, SerializedWriter, V4_IDENTITY_FORMAT, WORKSPACE_WRITER_BUSY_CODE, createDurableStorage, isWorkspaceDatabaseFileOpen, sqliteCapabilities, workspaceSafeId, WorkspaceDatabase, type DurableStorageOptions, type OutdatedWorkspaceRecord, type PublicationInput, type RegisteredWorkspace, type SourceIndexPublicationInput, type SqliteCapabilities } from "./storage.js";
export { createFaultInjector, noFaults, type FaultBoundary, type FaultInjector } from "./faults.js";
export { WorkspaceCandidateRepository, canonicalFrozenCandidateBaseTuple, frozenCandidateBaseTupleDigest, normalizeObservationBatchIds, sameFrozenCandidateBaseTuple, CANDIDATE_TEMPLATE_SET_KINDS, type CandidateCleanupMarker, type CandidateDeltaInput, type CandidateInsertResult, type CandidatePublicationInput, type CandidatePublicationResult, type CandidateRoot, type CandidateTemplateSetKind, type CandidateTemplateSets, type FrozenCandidateBaseTuple } from "./candidates.js";
export { WorkspaceProjectionOccurrenceRepository, type ProjectionOccurrenceDependency, type WorkspaceProjectionOccurrence, type WorkspaceVisibleProjection } from "./projection-occurrences.js";
export { acceptStagedColumnBatch, type StagedColumnBatch, type StagedColumnSection } from "./candidate-staging.js";
export { digestRelationalValue, flattenRelationalValue, hydrateRelationalValue, iterateRelationalValue, relationalValueCommands, RelationalValueBatchWriter, RELATIONAL_VALUE_BATCH_MAX_BYTES, RELATIONAL_VALUE_BATCH_MAX_PARAMETERS, RELATIONAL_VALUE_BATCH_MAX_ROWS, type RelationalValueKind, type RelationalValueRow } from "./relational-values.js";
export { WorkspaceProjectionRepository, type ArtifactDependency, type GraphEdge, type LexicalDocumentInput, type LexicalMatch, type MetricProjection, type SemanticIndexState, type VectorBatchInput, type VectorMatch, type VectorProjectionInput } from "./projections.js";
export { WorkspaceSourceIndexRepository, type CurrentSourceAbsence, type CurrentSourceOccurrence, type SlimArtifactTombstone, type SlimArtifactVersion, type SlimSourceAbsence, type SlimSourceArtifactIdentity, type SlimSourceOccurrence, type SourceIndexCommitInput, type SourceIndexContentInput, type SourceIndexContentStreamInput, type SourceIndexState } from "./source-index.js";
export { MIGRATION_TABLE_ADAPTERS, REPAIR_ORDER, StorageMaintenance, WorkspaceLifecycleRepository, projectionSetDigestEntries, projectionSetDigestRowsByKind, type CollectionOptions, type CollectionResult, type LiveProviderReindexPort, type ProjectionDigestKind, type ProjectionKindDigestRow, type QueryExecutionInput, type QueryExecutionRecord, type RepairComponentKind, type RepairRequest, type RepairResult, type RepairStorageContext, type RetentionLeaseInput, type SnapshotExpirationMarkerInput, type SnapshotPinInput, type SnapshotRebuildPort, type VerificationFailure, type VerificationReport } from "./lifecycle.js";
// Workspace fork (docs/decisions/12-workspace-fork.md) publication-layer
// primitives: a fork bulk-copies its canonical rows directly (raw SQL, not
// through this package's public repositories) and then needs only these two
// pieces of `publication-authority.ts` to mint its O(1) publication layer
// (candidate_state/registry/control-plane/manifest/snapshot/journal/current-state)
// with the same transactional guarantees (single transaction, CAS-guarded
// current-state swap, `assert_transaction_changes` checks) an ordinary
// candidate publish uses -- see `packages/engine/src/workspace-fork.ts`.
export { buildForkPublicationPlan, buildPublicationTransactionCommands, publicationTransactionCommands, computeForkSnapshotDigestFields, snapshotDigest, type ForkPublicationPlanInput, type PublicationCommandGroups } from "./publication-authority.js";
