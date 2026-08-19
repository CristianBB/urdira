# Universal Data Model

Status: **Approved**  
Last updated: 2026-08-08  
Depends on: Product foundation  
Blocks: Plugin contract, query algebra, incremental indexing, and storage architecture

## Decision objective

Define Urdira's language-neutral canonical representation of source-derived knowledge. The model must preserve exact source ownership, support incremental invalidation and immutable snapshots, allow language-specific extensions, and serve as the source of truth for graph, lexical, vector, and other derived projections.

This specification defines the logical model. It deliberately does not select a physical database. Its normative deterministic representation is [Urdira Canonical Encoding](../serialization/urdira-canonical-encoding.md).

## Model inventory and traceability

This inventory ensures that every model introduced during the design is represented explicitly. A model may be defined here while its lifecycle or API behavior is owned by another decision specification.

Status meanings in this table:

- **Approved model**: exact logical fields and lifecycle invariants are accepted; physical representation remains implementation-owned.
- **Approved concept**: an approved abstract family, union, or registry concept whose exact concrete member shapes are defined in this document; it does not denote an unresolved decision.
- **Provisional shape**: a concrete model has been introduced but remains dependent on an unresolved decision.

| Model | Plane | Status | Owning decision area |
|---|---|---|---|
| `Codebase` | Control | Approved concept | [Workspace, snapshot, and incremental indexing](04-workspace-snapshot-incremental-indexing.md) |
| `Workspace` | Control | Approved concept | [Workspace, snapshot, and incremental indexing](04-workspace-snapshot-incremental-indexing.md) |
| `WorkspaceConfigurationRevision` | Control | Approved model | [Configuration, security, and lifecycle](09-configuration-security-lifecycle.md) |
| `WorkspaceSourceProviderBinding` | Control value | Approved model | [Workspace, snapshot, and incremental indexing](04-workspace-snapshot-incremental-indexing.md) |
| `VcsState` | Control | Approved model | [Workspace, snapshot, and incremental indexing](04-workspace-snapshot-incremental-indexing.md) |
| `Snapshot` | Control | Approved model | [Workspace, snapshot, and incremental indexing](04-workspace-snapshot-incremental-indexing.md) |
| `WorkspaceCurrentState` | Control | Approved model | [Workspace, snapshot, and incremental indexing](04-workspace-snapshot-incremental-indexing.md) |
| `WorkspaceFreshnessCheckpoint` | Control | Approved model | [Workspace, snapshot, and incremental indexing](04-workspace-snapshot-incremental-indexing.md) |
| `ProviderWatermark` | Control value | Approved model | [Workspace, snapshot, and incremental indexing](04-workspace-snapshot-incremental-indexing.md) |
| `ProjectionSetDigestEntry` | Control value | Approved model | [Storage and projection architecture](05-storage-projection-architecture.md) |
| `SnapshotCapabilityStateEntry` | Control value | Approved model | This specification |
| `OrderedSetDescriptor` | Control value | Approved model | This specification |
| `CanonicalSchemaDefinition` | Schema registry | Approved model | [Urdira Canonical Encoding](../serialization/urdira-canonical-encoding.md) |
| `CanonicalNamedTypeDefinition` | Schema registry value | Approved model | [Urdira Canonical Encoding](../serialization/urdira-canonical-encoding.md) |
| `CanonicalTypeExpression` | Schema registry value union | Approved model | [Urdira Canonical Encoding](../serialization/urdira-canonical-encoding.md) |
| `NullTypeExpression` | Schema registry value | Approved model | [Urdira Canonical Encoding](../serialization/urdira-canonical-encoding.md) |
| `BooleanTypeExpression` | Schema registry value | Approved model | [Urdira Canonical Encoding](../serialization/urdira-canonical-encoding.md) |
| `SafeIntegerTypeExpression` | Schema registry value | Approved model | [Urdira Canonical Encoding](../serialization/urdira-canonical-encoding.md) |
| `BigIntegerTypeExpression` | Schema registry value | Approved model | [Urdira Canonical Encoding](../serialization/urdira-canonical-encoding.md) |
| `Float64TypeExpression` | Schema registry value | Approved model | [Urdira Canonical Encoding](../serialization/urdira-canonical-encoding.md) |
| `ExactDecimalTypeExpression` | Schema registry value | Approved model | [Urdira Canonical Encoding](../serialization/urdira-canonical-encoding.md) |
| `TextTypeExpression` | Schema registry value | Approved model | [Urdira Canonical Encoding](../serialization/urdira-canonical-encoding.md) |
| `BytesTypeExpression` | Schema registry value | Approved model | [Urdira Canonical Encoding](../serialization/urdira-canonical-encoding.md) |
| `TimestampTypeExpression` | Schema registry value | Approved model | [Urdira Canonical Encoding](../serialization/urdira-canonical-encoding.md) |
| `DigestTypeExpression` | Schema registry value | Approved model | [Urdira Canonical Encoding](../serialization/urdira-canonical-encoding.md) |
| `EnumTypeExpression` | Schema registry value | Approved model | [Urdira Canonical Encoding](../serialization/urdira-canonical-encoding.md) |
| `SequenceTypeExpression` | Schema registry value | Approved model | [Urdira Canonical Encoding](../serialization/urdira-canonical-encoding.md) |
| `SetTypeExpression` | Schema registry value | Approved model | [Urdira Canonical Encoding](../serialization/urdira-canonical-encoding.md) |
| `OrderedSetTypeExpression` | Schema registry value | Approved model | [Urdira Canonical Encoding](../serialization/urdira-canonical-encoding.md) |
| `MapTypeExpression` | Schema registry value | Approved model | [Urdira Canonical Encoding](../serialization/urdira-canonical-encoding.md) |
| `RecordTypeExpression` | Schema registry value | Approved model | [Urdira Canonical Encoding](../serialization/urdira-canonical-encoding.md) |
| `UnionTypeExpression` | Schema registry value | Approved model | [Urdira Canonical Encoding](../serialization/urdira-canonical-encoding.md) |
| `SchemaReferenceTypeExpression` | Schema registry value | Approved model | [Urdira Canonical Encoding](../serialization/urdira-canonical-encoding.md) |
| `SchemaFieldDefinition` | Schema registry value | Approved model | [Urdira Canonical Encoding](../serialization/urdira-canonical-encoding.md) |
| `SchemaVariantDefinition` | Schema registry value | Approved model | [Urdira Canonical Encoding](../serialization/urdira-canonical-encoding.md) |
| `HashAlgorithmDefinition` | Canonical support registry | Approved model | [Urdira Canonical Encoding](../serialization/urdira-canonical-encoding.md) |
| `DigestDomainDefinition` | Canonical support registry | Approved model | [Urdira Canonical Encoding](../serialization/urdira-canonical-encoding.md) |
| `CanonicalComparatorDefinition` | Canonical support registry | Approved model | [Core canonical comparators](../serialization/core-canonical-comparators.md) |
| `CanonicalComparatorSortKey` | Canonical support registry value | Approved model | [Core canonical comparators](../serialization/core-canonical-comparators.md) |
| `ExternalVerificationContractDefinition` | Canonical support registry | Approved model | [Urdira Canonical Encoding](../serialization/urdira-canonical-encoding.md) |
| `RuntimeComponentDefinition` | Component registry | Approved model | [Language plugin contract](02-language-plugin-contract.md) |
| `RuntimeComponentContractBinding` | Component registry value | Approved model | [Language plugin contract](02-language-plugin-contract.md) |
| `RuntimeComponentBuild` | Local runtime-build registry | Approved model | [Daemon, MCP integration, and packaging](10-daemon-mcp-packaging.md) |
| `DigestRecipeDefinition` | Schema registry | Approved model | [Urdira Canonical Encoding](../serialization/urdira-canonical-encoding.md) |
| `DigestComputationContext` | Digest computation value | Approved model | [Urdira Canonical Encoding](../serialization/urdira-canonical-encoding.md) |
| `DigestPayloadBinding` | Schema registry value union | Approved model | [Urdira Canonical Encoding](../serialization/urdira-canonical-encoding.md) |
| `ScalarDigestPayloadBinding` | Schema registry value | Approved model | [Urdira Canonical Encoding](../serialization/urdira-canonical-encoding.md) |
| `RecordDigestPayloadBinding` | Schema registry value | Approved model | [Urdira Canonical Encoding](../serialization/urdira-canonical-encoding.md) |
| `DigestPayloadFieldBinding` | Schema registry value | Approved model | [Urdira Canonical Encoding](../serialization/urdira-canonical-encoding.md) |
| `DigestReferenceDefinition` | Schema registry | Approved model | [Urdira Canonical Encoding](../serialization/urdira-canonical-encoding.md) |
| `DigestLocatorBinding` | Schema registry value | Approved model | [Urdira Canonical Encoding](../serialization/urdira-canonical-encoding.md) |
| `CanonicalEncodingErrorCodeDefinition` | Protocol registry | Approved model | [Core canonical encoding errors](../serialization/core-canonical-encoding-error-codes.md) |
| `CanonicalEncodingConformanceCase` | Conformance value | Approved model | [Urdira Canonical Encoding](../serialization/urdira-canonical-encoding.md) |
| `SourceProvider` | Source interface | Approved concept | [Workspace, snapshot, and incremental indexing](04-workspace-snapshot-incremental-indexing.md) |
| `SourceProviderRequestEnvelope` | Source protocol value | Approved model | [Workspace, snapshot, and incremental indexing](04-workspace-snapshot-incremental-indexing.md) |
| `SourceProviderResponseEnvelope` | Source protocol value | Approved model | [Workspace, snapshot, and incremental indexing](04-workspace-snapshot-incremental-indexing.md) |
| `SourceProviderDescribeRequest` | Source protocol value | Approved model | [Workspace, snapshot, and incremental indexing](04-workspace-snapshot-incremental-indexing.md) |
| `SourceProviderDescribeResult` | Source protocol value | Approved model | [Workspace, snapshot, and incremental indexing](04-workspace-snapshot-incremental-indexing.md) |
| `SourceProviderEnumerateRequest` | Source protocol value | Approved model | [Workspace, snapshot, and incremental indexing](04-workspace-snapshot-incremental-indexing.md) |
| `SourceProviderEnumerateResult` | Source protocol value | Approved model | [Workspace, snapshot, and incremental indexing](04-workspace-snapshot-incremental-indexing.md) |
| `SourceProviderReadRequest` | Source protocol value | Approved model | [Workspace, snapshot, and incremental indexing](04-workspace-snapshot-incremental-indexing.md) |
| `SourceProviderReadResult` | Source protocol value | Approved model | [Workspace, snapshot, and incremental indexing](04-workspace-snapshot-incremental-indexing.md) |
| `SourceProviderWatchRequest` | Source protocol value | Approved model | [Workspace, snapshot, and incremental indexing](04-workspace-snapshot-incremental-indexing.md) |
| `SourceProviderWatchResult` | Source protocol value | Approved model | [Workspace, snapshot, and incremental indexing](04-workspace-snapshot-incremental-indexing.md) |
| `SourceProviderWatchEvent` | Source protocol value | Approved model | [Workspace, snapshot, and incremental indexing](04-workspace-snapshot-incremental-indexing.md) |
| `SourceProviderReconcileRequest` | Source protocol value | Approved model | [Workspace, snapshot, and incremental indexing](04-workspace-snapshot-incremental-indexing.md) |
| `SourceProviderReconcileResult` | Source protocol value | Approved model | [Workspace, snapshot, and incremental indexing](04-workspace-snapshot-incremental-indexing.md) |
| `SourceProviderResourceBudget` | Source protocol value | Approved model | [Workspace, snapshot, and incremental indexing](04-workspace-snapshot-incremental-indexing.md) |
| `SourceProviderFeatureSet` | Source protocol value | Approved model | [Workspace, snapshot, and incremental indexing](04-workspace-snapshot-incremental-indexing.md) |
| `SourceProviderError` | Source protocol value | Approved model | [Workspace, snapshot, and incremental indexing](04-workspace-snapshot-incremental-indexing.md) |
| `AnalysisRelevantArtifactMetadata` | Canonical verified input | Approved model | [Core canonical schemas](../serialization/core-canonical-schemas.md) |
| `AnalysisConfiguration` | Canonical verified input | Approved model | [Core canonical schemas](../serialization/core-canonical-schemas.md) |
| `QueryConfiguration` | Canonical verified input | Approved model | [Core canonical schemas](../serialization/core-canonical-schemas.md) |
| `GeneratorConfiguration` | Canonical verified input | Approved model | [Core canonical schemas](../serialization/core-canonical-schemas.md) |
| `SourceProviderConfiguration` | Canonical verified input | Approved model | [Core canonical schemas](../serialization/core-canonical-schemas.md) |
| `NormalizedConfigurationLayer` | Canonical verified input | Approved model | [Core canonical schemas](../serialization/core-canonical-schemas.md) |
| `AnalyzerImplementationManifest` | Canonical verified input | Approved model | [Core canonical schemas](../serialization/core-canonical-schemas.md) |
| `RuntimeComponentBehaviorManifest` | Canonical verified input | Approved model | [Core canonical schemas](../serialization/core-canonical-schemas.md) |
| `RuntimeComponentImplementationManifest` | Canonical verified input | Approved model | [Core canonical schemas](../serialization/core-canonical-schemas.md) |
| `PluginPackageManifest` | Canonical verified input | Approved model | [Core canonical schemas](../serialization/core-canonical-schemas.md) |
| `PackageFileEntry` | Canonical verified-input value | Approved model | [Core canonical schemas](../serialization/core-canonical-schemas.md) |
| `CoreRegistryManifest` | Canonical verified input | Approved model | [Core canonical schemas](../serialization/core-canonical-schemas.md) |
| `CoreRegistryDefinition` | Canonical verified-input value | Approved model | [Core canonical schemas](../serialization/core-canonical-schemas.md) |
| `CandidateRegistryState` | Canonical verified input | Approved model | [Core canonical schemas](../serialization/core-canonical-schemas.md) |
| `CandidateNamespaceOwner` | Canonical verified-input value | Approved model | [Core canonical schemas](../serialization/core-canonical-schemas.md) |
| `CompatibilityRequirementValue` | Canonical verified-input value | Approved model | [Core canonical schemas](../serialization/core-canonical-schemas.md) |
| `ArtifactPartitionKey` | Capability partition value | Approved model | [Core canonical schemas](../serialization/core-canonical-schemas.md) |
| `CallablePartitionKey` | Capability partition value | Approved model | [Core canonical schemas](../serialization/core-canonical-schemas.md) |
| `FrameworkPartitionKey` | Capability partition value | Approved model | [Core canonical schemas](../serialization/core-canonical-schemas.md) |
| `ProjectPartitionKey` | Capability partition value | Approved model | [Core canonical schemas](../serialization/core-canonical-schemas.md) |
| `FrozenCandidateDigestInputs` | Canonical digest input | Approved model | [Core canonical schemas](../serialization/core-canonical-schemas.md) |
| `ArtifactAnalysisContext` | Canonical digest input | Approved model | [Core canonical schemas](../serialization/core-canonical-schemas.md) |
| `ProjectionSetDigestItem` | Canonical digest input value | Approved model | [Core canonical schemas](../serialization/core-canonical-schemas.md) |
| `QueryableVectorDigestEntry` | Canonical digest input value | Approved model | [Core canonical schemas](../serialization/core-canonical-schemas.md) |
| `RecordSetDigestEntry` | Canonical digest input value | Approved model | [Core canonical schemas](../serialization/core-canonical-schemas.md) |
| `RetentionRootReference` | Canonical digest input value | Approved model | [Core canonical schemas](../serialization/core-canonical-schemas.md) |
| `StoredObjectReference` | Canonical digest input value | Approved model | [Core canonical schemas](../serialization/core-canonical-schemas.md) |
| `VisibleSourceStateSet` | Canonical digest input value | Approved model | [Core canonical schemas](../serialization/core-canonical-schemas.md) |
| `NormalizedResponseBudget` | Canonical query-plan value | Approved model | [Core canonical schemas](../serialization/core-canonical-schemas.md) |
| `NormalizedResultProjection` | Canonical query-plan value | Approved model | [Core canonical schemas](../serialization/core-canonical-schemas.md) |
| `NormalizedIndexStatusProjection` | Canonical status-plan value | Approved model | [Core canonical schemas](../serialization/core-canonical-schemas.md) |
| `NormalizedQueryPlan` | Canonical query-plan value | Approved model | [Core canonical schemas](../serialization/core-canonical-schemas.md) |
| `OperationVersionBinding` | Canonical query-plan value | Approved model | [Core canonical schemas](../serialization/core-canonical-schemas.md) |
| `RecipeVersionBinding` | Canonical query-plan value | Approved model | [Core canonical schemas](../serialization/core-canonical-schemas.md) |
| `RecipeStaticArguments` | Canonical recipe value | Approved model | [Core canonical schemas](../serialization/core-canonical-schemas.md) |
| `LocateImplementationArguments` | Recipe request value | Approved model | [Core canonical schemas](../serialization/core-canonical-schemas.md) |
| `UnderstandChangeImpactArguments` | Recipe request value | Approved model | [Core canonical schemas](../serialization/core-canonical-schemas.md) |
| `PrepareSymbolChangeArguments` | Recipe request value | Approved model | [Core canonical schemas](../serialization/core-canonical-schemas.md) |
| `PrepareNewFeatureArguments` | Recipe request value | Approved model | [Core canonical schemas](../serialization/core-canonical-schemas.md) |
| `TraceBehaviorArguments` | Recipe request value | Approved model | [Core canonical schemas](../serialization/core-canonical-schemas.md) |
| `FindRelevantTestsArguments` | Recipe request value | Approved model | [Core canonical schemas](../serialization/core-canonical-schemas.md) |
| `ExplainArchitectureSliceArguments` | Recipe request value | Approved model | [Core canonical schemas](../serialization/core-canonical-schemas.md) |
| `CompareWorkspacesArguments` | Recipe request value | Approved model | [Core canonical schemas](../serialization/core-canonical-schemas.md) |
| `SemanticToCallersArguments` | Recipe request value | Approved model | [Core canonical schemas](../serialization/core-canonical-schemas.md) |
| `ResolveAndFindReferencesArguments` | Recipe request value | Approved model | [Core canonical schemas](../serialization/core-canonical-schemas.md) |
| `DefinitionToInstancesArguments` | Recipe request value | Approved model | [Core canonical schemas](../serialization/core-canonical-schemas.md) |
| `SourceArtifact` | Source catalog | Approved concept | This specification |
| `ArtifactVersion` | Source catalog | Approved model | This specification |
| `ArtifactTombstone` | Source catalog | Approved model | This specification |
| `ArtifactChange` | Index lifecycle | Approved model | This specification |
| `SourceObservation` | Source catalog | Approved model | [Workspace, snapshot, and incremental indexing](04-workspace-snapshot-incremental-indexing.md) |
| `SourceObservationDigestEntry` | Digest input value | Approved model | [Urdira Canonical Encoding](../serialization/urdira-canonical-encoding.md) |
| `VisibleSourceStateEntry` | Digest input value union | Approved model | [Urdira Canonical Encoding](../serialization/urdira-canonical-encoding.md) |
| `PresentSourceStateEntry` | Digest input value | Approved model | [Urdira Canonical Encoding](../serialization/urdira-canonical-encoding.md) |
| `AbsentSourceStateEntry` | Digest input value | Approved model | [Urdira Canonical Encoding](../serialization/urdira-canonical-encoding.md) |
| `SourceObservationBatch` | Source catalog | Approved model | [Workspace, snapshot, and incremental indexing](04-workspace-snapshot-incremental-indexing.md) |
| `ObservationCoverageScope` | Source value | Approved model | [Workspace, snapshot, and incremental indexing](04-workspace-snapshot-incremental-indexing.md) |
| `ChangeCauseReference` | Lifecycle value | Approved model | This specification |
| `ContentBlob` | Source catalog | Approved concept | This specification |
| `SourceSpan` | Source catalog | Approved concept | This specification |
| `RecordEnvelope` | Knowledge | Approved model | This specification |
| `RecordKindDefinition` | Schema registry | Approved concept | This specification |
| `FacetDefinition` | Schema registry | Approved concept | This specification |
| `SemanticRoleDefinition` | Schema registry | Approved concept | This specification |
| `MetricDefinition` | Schema registry | Approved concept | This specification |
| `EffectDefinition` | Schema registry | Approved concept | This specification |
| `DependencyRoleDefinition` | Schema registry | Approved model | This specification |
| `ProjectionKindDefinition` | Schema registry | Approved model | This specification |
| `LifecycleReasonCodeDefinition` | Schema registry | Approved model | This specification |
| `CompletenessReasonDefinition` | Schema registry | Approved model | This specification |
| `LanguageDefinition` | Schema registry | Approved model | This specification |
| `LanguageDefinitionSupply` | Registry supply value | Approved model | This specification |
| `CapabilityContractDefinition` | Schema registry | Approved model | This specification |
| `CapabilityDependencyObligation` | Schema registry value | Approved model | This specification |
| `CapabilityCompletenessSemantics` | Schema registry value | Approved model | This specification |
| `ConstructClassDefinition` | Schema registry | Approved model | This specification |
| `CapabilityLimitationDefinition` | Schema registry | Approved model | This specification |
| `SemanticSectionKindDefinition` | Schema registry | Approved model | [Semantic search and ranking](06-semantic-search-ranking.md) |
| `SemanticReasonDefinition` | Schema registry | Approved model | [Semantic search and ranking](06-semantic-search-ranking.md) |
| `EmbeddingProfile` | Schema registry | Approved model | [Semantic search and ranking](06-semantic-search-ranking.md) |
| `EmbeddingInputContract` | Schema registry value | Approved model | [Semantic search and ranking](06-semantic-search-ranking.md) |
| `EmbeddingSegmentationContract` | Schema registry value | Approved model | [Semantic search and ranking](06-semantic-search-ranking.md) |
| `EmbeddingLanguageSupport` | Schema registry value | Approved model | [Semantic search and ranking](06-semantic-search-ranking.md) |
| `ModelPackManifest` | Model-pack manifest | Approved model | [Daemon, MCP integration, and packaging](10-daemon-mcp-packaging.md) |
| `ModelPackAssetEntry` | Model-pack manifest value | Approved model | [Daemon, MCP integration, and packaging](10-daemon-mcp-packaging.md) |
| `ModelAssetManifest` | Model-pack asset value | Approved model | [Daemon, MCP integration, and packaging](10-daemon-mcp-packaging.md) |
| `TokenizerAssetManifest` | Model-pack asset value | Approved model | [Daemon, MCP integration, and packaging](10-daemon-mcp-packaging.md) |
| `ModelPackRuntimeConfiguration` | Model-pack asset value | Approved model | [Daemon, MCP integration, and packaging](10-daemon-mcp-packaging.md) |
| `ModelPackRuntimeRequirement` | Model-pack manifest value | Approved model | [Daemon, MCP integration, and packaging](10-daemon-mcp-packaging.md) |
| `ResolvedModelPackRuntimeBuild` | Embedding runtime registry value | Approved model | [Daemon, MCP integration, and packaging](10-daemon-mcp-packaging.md) |
| `ModelPackCoordinateReservation` | Model-pack installation registry | Approved model | [Daemon, MCP integration, and packaging](10-daemon-mcp-packaging.md) |
| `ModelPackInstallation` | Model-pack installation registry | Approved model | [Daemon, MCP integration, and packaging](10-daemon-mcp-packaging.md) |
| `EmbeddingProfileExecutableBinding` | Embedding runtime registry | Approved model | [Daemon, MCP integration, and packaging](10-daemon-mcp-packaging.md) |
| `ModelPackProfileSupply` | Embedding runtime registry | Approved model | [Daemon, MCP integration, and packaging](10-daemon-mcp-packaging.md) |
| `EvidenceAssumptionDefinition` | Schema registry | Approved model | This specification |
| `EvidenceExplanationDefinition` | Schema registry | Approved model | This specification |
| `PluginRegistryContribution` | Plugin registry | Approved concept | This specification |
| `PluginDependencyRequirement` | Plugin registry | Approved concept | This specification |
| `NamespaceBinding` | Control | Approved model | This specification |
| `RegistryNamespaceBindingEntry` | Control value | Approved model | This specification |
| `RegistrySnapshot` | Control | Approved concept | This specification |
| `VersionRequirement` | Compatibility value | Approved concept | This specification |
| `VersionInterval` | Compatibility value | Approved concept | This specification |
| `CapabilityRequirement` | Plugin registry | Approved concept | This specification |
| `PluginCompatibilityDeclaration` | Plugin registry | Approved concept | This specification |
| `PluginResolutionLock` | Control | Approved concept | This specification |
| `ResolvedPlugin` | Control | Approved concept | This specification |
| `RegistryCompatibilityAssessment` | Control | Approved concept | This specification |
| `DefinitionChangeAssessment` | Control | Approved concept | This specification |
| `PluginAnalysisChange` | Control | Approved concept | This specification |
| `IndexCandidate` | Control | Approved model | [Workspace, snapshot, and incremental indexing](04-workspace-snapshot-incremental-indexing.md) |
| `CandidateMaterialization` | Control | Approved model | This specification |
| `CandidateSourceTransitionTemplate` | Control value | Approved model | This specification |
| `CandidateRecordOpenTemplate` | Control value | Approved model | This specification |
| `CandidateRecordClosureTemplate` | Control value | Approved model | This specification |
| `CandidateIdentityAssignmentTemplate` | Control value | Approved model | This specification |
| `CandidateProjectionOpenTemplate` | Control value | Approved model | This specification |
| `CandidateProjectionTemplate` | Control value | Approved model | This specification |
| `CandidateProjectionClosureTemplate` | Control value | Approved model | This specification |
| `CandidateWorkManifest` | Control | Approved model | [Workspace, snapshot, and incremental indexing](04-workspace-snapshot-incremental-indexing.md) |
| `ArtifactWorkItem` | Control | Approved model | [Workspace, snapshot, and incremental indexing](04-workspace-snapshot-incremental-indexing.md) |
| `ProjectionWorkItem` | Control | Approved model | [Workspace, snapshot, and incremental indexing](04-workspace-snapshot-incremental-indexing.md) |
| `InvalidationPlan` | Control | Approved model | [Workspace, snapshot, and incremental indexing](04-workspace-snapshot-incremental-indexing.md) |
| `CandidateIssue` | Control | Approved model | [Workspace, snapshot, and incremental indexing](04-workspace-snapshot-incremental-indexing.md) |
| `CandidateIssueCodeDefinition` | Protocol registry | Approved model | This specification |
| `CandidateIssueScope` | Control value | Approved model | [Workspace, snapshot, and incremental indexing](04-workspace-snapshot-incremental-indexing.md) |
| `WorkspaceCandidateIssueScope` | Control value | Approved model | [Workspace, snapshot, and incremental indexing](04-workspace-snapshot-incremental-indexing.md) |
| `ArtifactCandidateIssueScope` | Control value | Approved model | [Workspace, snapshot, and incremental indexing](04-workspace-snapshot-incremental-indexing.md) |
| `WorkItemCandidateIssueScope` | Control value | Approved model | [Workspace, snapshot, and incremental indexing](04-workspace-snapshot-incremental-indexing.md) |
| `FactDeltaCandidateIssueScope` | Control value | Approved model | [Workspace, snapshot, and incremental indexing](04-workspace-snapshot-incremental-indexing.md) |
| `ReplacementScopeCandidateIssueScope` | Control value | Approved model | [Workspace, snapshot, and incremental indexing](04-workspace-snapshot-incremental-indexing.md) |
| `ProposalCandidateIssueScope` | Control value | Approved model | [Workspace, snapshot, and incremental indexing](04-workspace-snapshot-incremental-indexing.md) |
| `ProjectionCandidateIssueScope` | Control value | Approved model | [Workspace, snapshot, and incremental indexing](04-workspace-snapshot-incremental-indexing.md) |
| `InvalidationPathStep` | Control value | Approved model | [Workspace, snapshot, and incremental indexing](04-workspace-snapshot-incremental-indexing.md) |
| `InvalidationNodeReference` | Control value | Approved model | [Workspace, snapshot, and incremental indexing](04-workspace-snapshot-incremental-indexing.md) |
| `AffectedArtifactEntry` | Control value | Approved model | [Workspace, snapshot, and incremental indexing](04-workspace-snapshot-incremental-indexing.md) |
| `AffectedRecordEntry` | Control value | Approved model | [Workspace, snapshot, and incremental indexing](04-workspace-snapshot-incremental-indexing.md) |
| `AffectedProjectionEntry` | Control value | Approved model | [Workspace, snapshot, and incremental indexing](04-workspace-snapshot-incremental-indexing.md) |
| `PluginUpgradePlan` | Control | Approved concept | This specification |
| `PluginActivationAttempt` | Control | Approved concept | This specification |
| `PluginCompatibilityIssue` | Control | Approved concept | This specification |
| `PluginCompatibilityIssueCodeDefinition` | Protocol registry | Approved concept | This specification |
| `RegistryDefinitionReference` | Compatibility value | Approved concept | This specification |
| `CompatibilityRequirementReference` | Compatibility value | Approved concept | This specification |
| `KindDescriptor` | Query result | Approved concept | This specification |
| `KindSelector` | Query request | Approved concept | This specification |
| `KindDefinitionView` | Query result | Approved concept | This specification |
| `RegistryIncludeOptions` | Query request | Approved concept | This specification |
| `RegistryBundle` | Query result | Approved concept | This specification |
| `EntityRecord` | Knowledge | Approved concept | This specification |
| `RelationRecord` | Knowledge | Approved concept | This specification |
| `RelationArgument` | Knowledge | Approved concept | This specification |
| `RelationKindDefinition` | Schema registry | Approved concept | This specification |
| `RelationRoleDefinition` | Schema registry | Approved concept | This specification |
| `RelationIdentityInput` | Plugin transport value | Approved model | This specification |
| `RelationTarget` | Knowledge value | Approved concept | This specification |
| `EntityTarget` | Knowledge value | Approved concept | This specification |
| `RecordTarget` | Knowledge value | Approved concept | This specification |
| `ArtifactTarget` | Knowledge value | Approved concept | This specification |
| `LiteralTarget` | Knowledge value | Approved concept | This specification |
| `UnresolvedTarget` | Knowledge value | Approved concept | This specification |
| `FactRecord` | Knowledge | Approved concept | This specification |
| `EvidenceRecord` | Knowledge | Approved concept | This specification |
| `EvidenceSubject` | Knowledge value | Approved concept | This specification |
| `RecordSubject` | Knowledge value | Approved concept | This specification |
| `RelationArgumentSubject` | Knowledge value | Approved concept | This specification |
| `SourceReference` | Knowledge value | Approved concept | This specification |
| `DiagnosticRecord` | Knowledge | Approved concept | This specification |
| `DiagnosticScope` | Knowledge value | Approved concept | This specification |
| `RecordDiagnosticScope` | Knowledge value | Approved concept | This specification |
| `ArtifactDiagnosticScope` | Knowledge value | Approved concept | This specification |
| `CapabilityDiagnosticScope` | Knowledge value | Approved concept | This specification |
| `DiagnosticRecovery` | Knowledge value | Approved concept | This specification |
| `DiagnosticCodeDefinition` | Schema registry | Approved concept | This specification |
| `DerivedProjectionEnvelope` | Derived projection | Approved model | [Storage and projection architecture](05-storage-projection-architecture.md) |
| `ProjectionChange` | Derived projection | Approved model | [Storage and projection architecture](05-storage-projection-architecture.md) |
| `DerivedSemanticEligibility` | Derived projection | Approved model | [Semantic search and ranking](06-semantic-search-ranking.md) |
| `DerivedSemanticDocument` | Derived projection | Approved model | [Semantic search and ranking](06-semantic-search-ranking.md) |
| `SemanticDocumentSubject` | Derived projection value | Approved model | [Semantic search and ranking](06-semantic-search-ranking.md) |
| `ArtifactSemanticDocumentSubject` | Derived projection value | Approved model | [Semantic search and ranking](06-semantic-search-ranking.md) |
| `EntitySemanticDocumentSubject` | Derived projection value | Approved model | [Semantic search and ranking](06-semantic-search-ranking.md) |
| `SemanticDocumentSection` | Derived projection value | Approved model | [Semantic search and ranking](06-semantic-search-ranking.md) |
| `DerivedEmbeddingSegment` | Derived projection | Approved model | [Semantic search and ranking](06-semantic-search-ranking.md) |
| `EmbeddingSegmentPart` | Derived projection value | Approved model | [Semantic search and ranking](06-semantic-search-ranking.md) |
| `DerivedEmbeddingVector` | Derived projection | Approved model | [Semantic search and ranking](06-semantic-search-ranking.md) |
| `SemanticArtifactCoverage` | Projection control | Approved model | [Semantic search and ranking](06-semantic-search-ranking.md) |
| `SemanticCoverageManifest` | Projection control value | Approved model | [Semantic search and ranking](06-semantic-search-ranking.md) |
| `SemanticIndexMaterialization` | Projection control | Approved model | [Semantic search and ranking](06-semantic-search-ranking.md) |
| `RecordArtifactDependency` | Knowledge index | Approved model | This specification |
| `RecordArtifactDependencyDigestEntry` | Digest input value | Approved model | [Urdira Canonical Encoding](../serialization/urdira-canonical-encoding.md) |
| `GenerationChangeManifest` | Index lifecycle | Approved model | This specification |
| `ChangeSetDescriptor` | Index lifecycle | Approved model | This specification |
| `ProjectionChangeSetDescriptor` | Index lifecycle | Approved model | This specification |
| `RecordOpen` | Index lifecycle | Approved model | This specification |
| `RecordClosure` | Index lifecycle | Approved model | This specification |
| `IdentityAssignment` | Index lifecycle | Approved model | This specification |
| `FactDelta` | Plugin transport | Approved model | [Language plugin contract](02-language-plugin-contract.md) |
| `ReplacementScope` | Plugin transport | Approved model | [Language plugin contract](02-language-plugin-contract.md) |
| `ProposedRecord` | Plugin transport | Approved model | [Language plugin contract](02-language-plugin-contract.md) |
| `ProposedReference` | Plugin transport | Approved model | [Language plugin contract](02-language-plugin-contract.md) |
| `LocalProposalReference` | Plugin transport value | Approved model | [Language plugin contract](02-language-plugin-contract.md) |
| `CandidateIdentityReference` | Plugin transport value | Approved model | [Language plugin contract](02-language-plugin-contract.md) |
| `BaseRecordReference` | Plugin transport value | Approved model | [Language plugin contract](02-language-plugin-contract.md) |
| `UnresolvedReference` | Plugin transport value | Approved model | [Language plugin contract](02-language-plugin-contract.md) |
| `ProposedRecordDependency` | Plugin transport | Approved model | [Language plugin contract](02-language-plugin-contract.md) |
| `CompletenessClaim` | Plugin transport | Approved model | [Language plugin contract](02-language-plugin-contract.md) |
| `PluginCapabilityDeclaration` | Plugin registry | Approved model | [Language plugin contract](02-language-plugin-contract.md) |
| `CapabilityCoverage` | Plugin registry value | Approved model | [Language plugin contract](02-language-plugin-contract.md) |
| `CapabilityLimitation` | Plugin registry value | Approved model | [Language plugin contract](02-language-plugin-contract.md) |
| `PluginWorkerRequestEnvelope` | Plugin protocol | Approved model | [Language plugin contract](02-language-plugin-contract.md) |
| `PluginWorkerResponseEnvelope` | Plugin protocol | Approved model | [Language plugin contract](02-language-plugin-contract.md) |
| `PluginDescribeRequest` | Plugin protocol | Approved model | [Language plugin contract](02-language-plugin-contract.md) |
| `PluginDescribeResult` | Plugin protocol | Approved model | [Language plugin contract](02-language-plugin-contract.md) |
| `DiscoverPartitionsRequest` | Plugin protocol | Approved model | [Language plugin contract](02-language-plugin-contract.md) |
| `DiscoverPartitionsResult` | Plugin protocol | Approved model | [Language plugin contract](02-language-plugin-contract.md) |
| `AnalysisPartition` | Plugin protocol value | Approved model | [Language plugin contract](02-language-plugin-contract.md) |
| `AnalyzeArtifactRequest` | Plugin protocol | Approved model | [Language plugin contract](02-language-plugin-contract.md) |
| `AnalyzeArtifactSuccess` | Plugin protocol | Approved model | [Language plugin contract](02-language-plugin-contract.md) |
| `GenerateProjectionRequest` | Plugin protocol | Approved model | [Language plugin contract](02-language-plugin-contract.md) |
| `GenerateProjectionSuccess` | Plugin protocol | Approved model | [Language plugin contract](02-language-plugin-contract.md) |
| `PluginAnalysisContext` | Plugin protocol value | Approved model | [Language plugin contract](02-language-plugin-contract.md) |
| `PluginAnalysisView` | Plugin protocol value | Approved model | [Language plugin contract](02-language-plugin-contract.md) |
| `PluginArtifactView` | Plugin protocol value | Approved model | [Language plugin contract](02-language-plugin-contract.md) |
| `PluginRecordView` | Plugin protocol value union | Approved model | [Language plugin contract](02-language-plugin-contract.md) |
| `BasePluginRecordView` | Plugin protocol value | Approved model | [Language plugin contract](02-language-plugin-contract.md) |
| `StagedPluginRecordView` | Plugin protocol value | Approved model | [Language plugin contract](02-language-plugin-contract.md) |
| `PluginInputLookupEntry` | Plugin protocol value | Approved model | [Language plugin contract](02-language-plugin-contract.md) |
| `PluginInputRecordEntry` | Plugin protocol value union | Approved model | [Language plugin contract](02-language-plugin-contract.md) |
| `BasePluginInputRecordEntry` | Plugin protocol value | Approved model | [Language plugin contract](02-language-plugin-contract.md) |
| `StagedPluginInputRecordEntry` | Plugin protocol value | Approved model | [Language plugin contract](02-language-plugin-contract.md) |
| `PluginInputAccessManifest` | Plugin protocol control | Approved model | [Language plugin contract](02-language-plugin-contract.md) |
| `PluginLookupInvalidationDependency` | Invalidation index | Approved model | [Language plugin contract](02-language-plugin-contract.md) |
| `PluginResourceBudget` | Plugin protocol value | Approved model | [Language plugin contract](02-language-plugin-contract.md) |
| `PluginInputsIncomplete` | Plugin protocol result | Approved model | [Language plugin contract](02-language-plugin-contract.md) |
| `PluginUnsupported` | Plugin protocol result | Approved model | [Language plugin contract](02-language-plugin-contract.md) |
| `PluginCancelled` | Plugin protocol result | Approved model | [Language plugin contract](02-language-plugin-contract.md) |
| `PluginResourceExhausted` | Plugin protocol result | Approved model | [Language plugin contract](02-language-plugin-contract.md) |
| `PluginFailed` | Plugin protocol result | Approved model | [Language plugin contract](02-language-plugin-contract.md) |
| `QueryRequest` | Query request | Approved model | [Query algebra and public API](03-query-algebra-public-api.md) |
| `QueryScope` | Query request value union | Approved model | [Query algebra and public API](03-query-algebra-public-api.md) |
| `SingleWorkspaceScope` | Query request value | Approved model | [Query algebra and public API](03-query-algebra-public-api.md) |
| `ComparisonScope` | Query request value | Approved model | [Query algebra and public API](03-query-algebra-public-api.md) |
| `QueryParticipant` | Query request value | Approved model | [Query algebra and public API](03-query-algebra-public-api.md) |
| `QueryExpression` | Query request value union | Approved model | [Query algebra and public API](03-query-algebra-public-api.md) |
| `OperationExpression` | Query request value | Approved model | [Query algebra and public API](03-query-algebra-public-api.md) |
| `PipelineExpression` | Query request value | Approved model | [Query algebra and public API](03-query-algebra-public-api.md) |
| `RecipeExpression` | Query request value | Approved model | [Query algebra and public API](03-query-algebra-public-api.md) |
| `QueryStage` | Query request value | Approved model | [Query algebra and public API](03-query-algebra-public-api.md) |
| `StageOutputReference` | Query request value | Approved model | [Query algebra and public API](03-query-algebra-public-api.md) |
| `DefinitionMatcher` | Query request value | Approved model | [Query algebra and public API](03-query-algebra-public-api.md) |
| `DefinitionSetReference` | Query request value | Approved model | [Query algebra and public API](03-query-algebra-public-api.md) |
| `SubjectSelector` | Query request value union | Approved model | [Public query contract](../protocol/public-query-contract.md) |
| `StructuralFilter` | Query request value | Approved model | [Public query contract](../protocol/public-query-contract.md) |
| `RelationSelector` | Query request value | Approved model | [Public query contract](../protocol/public-query-contract.md) |
| `RegistrySelector` | Query request value | Approved model | [Public query contract](../protocol/public-query-contract.md) |
| `ChangeDescriptor` | Query request value union | Approved model | [Public query contract](../protocol/public-query-contract.md) |
| `FindRecordsArguments` | Query request value | Approved model | [Public query contract](../protocol/public-query-contract.md) |
| `RecordStructuralSelector` | Query request value | Approved model | [Public query contract](../protocol/public-query-contract.md) |
| `QueryOptions` | Query request value | Approved model | [Query algebra and public API](03-query-algebra-public-api.md) |
| `ResponseBudget` | Query request value | Approved model | [Query algebra and public API](03-query-algebra-public-api.md) |
| `ContinuationRequest` | Query request | Approved model | [Query algebra and public API](03-query-algebra-public-api.md) |
| `IntentRecipeDefinition` | Query registry | Approved model | [Core intent recipes](../protocol/core-intent-recipes.md) |
| `IntentRecipeStageDefinition` | Query registry value | Approved model | [Core intent recipes](../protocol/core-intent-recipes.md) |
| `RecipeArgumentBinding` | Query registry value | Approved model | [Core intent recipes](../protocol/core-intent-recipes.md) |
| `IntentRecipeOutputDefinition` | Query registry value | Approved model | [Core intent recipes](../protocol/core-intent-recipes.md) |
| `IntentRecipeRankingBinding` | Query registry value | Approved model | [Core intent recipes](../protocol/core-intent-recipes.md) |
| `IntentRecipeGuardDefinition` | Query registry value | Approved model | [Core intent recipes](../protocol/core-intent-recipes.md) |
| `IntentRecipePaginationStream` | Query registry value | Approved model | [Core intent recipes](../protocol/core-intent-recipes.md) |
| `QueryExecution` | Query control | Approved concept | [Query algebra and public API](03-query-algebra-public-api.md) |
| `WorkspaceSnapshotBinding` | Query control value | Approved model | [Query algebra and public API](03-query-algebra-public-api.md) |
| `QueryEmbedding` | Query control value | Approved model | [Semantic search and ranking](06-semantic-search-ranking.md) |
| `SemanticIndexBinding` | Query control value | Approved model | [Semantic search and ranking](06-semantic-search-ranking.md) |
| `SemanticCoverageView` | Query result | Approved model | [Semantic search and ranking](06-semantic-search-ranking.md) |
| `SemanticAffectedArtifactView` | Query result value | Approved model | [Semantic search and ranking](06-semantic-search-ranking.md) |
| `SemanticAffectedArtifactPage` | Query result value | Approved model | [Semantic search and ranking](06-semantic-search-ranking.md) |
| `ResultManifestEntry` | Query cache | Approved concept | [Storage and projection architecture](05-storage-projection-architecture.md) |
| `ResultBundle` | Query result | Approved concept | [Query algebra and public API](03-query-algebra-public-api.md) |
| `ResultSubject` | Query result value | Approved model | [Query algebra and public API](03-query-algebra-public-api.md) |
| `EntityResultSubject` | Query result value | Approved model | [Query algebra and public API](03-query-algebra-public-api.md) |
| `RecordResultSubject` | Query result value | Approved model | [Query algebra and public API](03-query-algebra-public-api.md) |
| `ArtifactResultSubject` | Query result value | Approved model | [Query algebra and public API](03-query-algebra-public-api.md) |
| `PrimaryResultView` | Query result value union | Approved model | [Query algebra and public API](03-query-algebra-public-api.md) |
| `EntityPrimaryResultView` | Query result value | Approved model | [Query algebra and public API](03-query-algebra-public-api.md) |
| `RecordPrimaryResultView` | Query result value | Approved model | [Query algebra and public API](03-query-algebra-public-api.md) |
| `ArtifactPrimaryResultView` | Query result value | Approved model | [Query algebra and public API](03-query-algebra-public-api.md) |
| `CompletenessReport` | Query result | Approved concept | This specification |
| `CompletenessDimension` | Query result | Approved concept | This specification |
| `ResultAssessment` | Query result | Approved concept | This specification |
| `EvidenceSummary` | Query result | Approved concept | This specification |
| `EvidenceCitation` | Query result | Approved concept | This specification |
| `SourceReferenceView` | Query result | Approved concept | This specification |
| `SourceSnippet` | Query result | Approved concept | This specification |
| `SnippetRedaction` | Query result value | Approved model | [Configuration, security, and lifecycle](09-configuration-security-lifecycle.md) |
| `EvidenceIncludeOptions` | Query request | Approved concept | This specification |
| `SourceIncludeOptions` | Query request | Approved model | [Query algebra and public API](03-query-algebra-public-api.md) |
| `DiagnosticReport` | Query result | Approved concept | This specification |
| `DiagnosticView` | Query result | Approved concept | This specification |
| `DiagnosticIncludeOptions` | Query request | Approved concept | This specification |
| `OperationError` | Query protocol | Approved concept | This specification |
| `OperationErrorCodeDefinition` | Protocol registry | Approved concept | This specification |
| `CursorTokenClaims` | Query cache | Approved concept | [Query algebra and public API](03-query-algebra-public-api.md) |
| `QueryCursorTokenClaims` | Query cache | Approved model | [Query algebra and public API](03-query-algebra-public-api.md) |
| `IndexStatusCursorTokenClaims` | Status cache | Approved model | [Query algebra and public API](03-query-algebra-public-api.md) |
| `RegistryUsageSet` | Query cache | Approved model | [Query algebra and public API](03-query-algebra-public-api.md) |
| `RegistryUsageParentSlice` | Query cache value | Approved model | [Query algebra and public API](03-query-algebra-public-api.md) |
| `ResultSetPage` | Query result | Approved model | [Query algebra and public API](03-query-algebra-public-api.md) |
| `ResultStreamPage` | Query result | Approved concept | [Query algebra and public API](03-query-algebra-public-api.md) |
| `QueryResultPage` | Query result | Approved concept | [Query algebra and public API](03-query-algebra-public-api.md) |
| `IndexStatusRequest` | Status request union | Approved model | [Query algebra and public API](03-query-algebra-public-api.md) |
| `IndexStatusInitialRequest` | Status request | Approved model | [Query algebra and public API](03-query-algebra-public-api.md) |
| `IndexStatusContinuationRequest` | Status request | Approved model | [Query algebra and public API](03-query-algebra-public-api.md) |
| `IndexStatusExecution` | Status cache | Approved model | [Query algebra and public API](03-query-algebra-public-api.md) |
| `IndexStatusPage` | Status result | Approved model | [Query algebra and public API](03-query-algebra-public-api.md) |
| `WorkspaceStatusStreamPage` | Status result value | Approved model | [Query algebra and public API](03-query-algebra-public-api.md) |
| `WorkspaceIndexStatusView` | Status result value | Approved model | [Query algebra and public API](03-query-algebra-public-api.md) |
| `IndexCandidateStatusView` | Status result value | Approved model | [Query algebra and public API](03-query-algebra-public-api.md) |
| `WorkspacePluginStatusView` | Status result value | Approved model | [Query algebra and public API](03-query-algebra-public-api.md) |
| `WorkspaceCapabilityStatusView` | Status result value | Approved model | [Query algebra and public API](03-query-algebra-public-api.md) |
| `SemanticMaterializationStatusView` | Status result value | Approved model | [Query algebra and public API](03-query-algebra-public-api.md) |
| `ActivationAttemptStatusView` | Status result value | Approved model | [Query algebra and public API](03-query-algebra-public-api.md) |
| `ActivationIssueStatusView` | Status result value | Approved model | [Query algebra and public API](03-query-algebra-public-api.md) |
| `CandidateIssueStatusView` | Status result value | Approved model | [Query algebra and public API](03-query-algebra-public-api.md) |
| `ActivationIssueStatusStreamPage` | Status result value | Approved model | [Query algebra and public API](03-query-algebra-public-api.md) |
| `CandidateIssueStatusStreamPage` | Status result value | Approved model | [Query algebra and public API](03-query-algebra-public-api.md) |
| `RetentionLease` | Retention control | Approved model | [Storage and projection architecture](05-storage-projection-architecture.md) |
| `SnapshotRetentionPin` | Retention control | Approved model | [Storage and projection architecture](05-storage-projection-architecture.md) |
| `SnapshotExpirationMarker` | Retention control | Approved model | [Storage and projection architecture](05-storage-projection-architecture.md) |
| `SnapshotRetentionStatus` | Query result | Approved model | [Storage and projection architecture](05-storage-projection-architecture.md) |
| `GarbageCollectionEpoch` | Storage control | Approved model | [Storage and projection architecture](05-storage-projection-architecture.md) |
| `WorkspaceGcBoundary` | Storage control | Approved model | [Storage and projection architecture](05-storage-projection-architecture.md) |

Public request and response models are defined here so the inventory remains complete; their operation behavior and transport mapping are authoritative in the query-algebra specification. They are not canonical knowledge records.

## Approved foundational decisions

### Typed and extensible records

Urdira's canonical knowledge model is a versioned, schema-validated, extensible record system with a mandatory common envelope and namespaced record kinds.

The model will not be a property graph alone, a fully generic entity-attribute-value store, or a fixed set of language-specific tables. It combines:

- A small set of universal record categories.
- A mandatory common envelope.
- Schema-validated payloads selected by a record-kind discriminator.
- Core record kinds owned by Urdira.
- Namespaced extension kinds owned by plugins.
- Explicit schema versions and migration rules.

### Canonical truth and derived projections

The canonical model is the authoritative representation. Specialized structures are derived projections and must be rebuildable from canonical records and source artifacts.

Expected projections include:

- Structural graph.
- Temporal and relational indexes.
- Lexical index.
- Vector index.
- Metric aggregates and architectural summaries derived from canonical `core:metric` facts and other records.
- Materialized query-result manifests.

### Plane separation

The logical architecture distinguishes:

```text
Control plane
  Workspace
  Snapshot
  Plugin registration
  Query execution
  Cache lifecycle

Source catalog
  SourceArtifact
  ArtifactVersion
  SourceSpan

Knowledge plane
  EntityRecord
  RelationRecord
  FactRecord
  EvidenceRecord
  DiagnosticRecord

Derived projections
  Graph
  Lexical
  Vector
  Metrics
  Query manifests
```

Control-plane records are not source-derived and do not receive fictitious file ownership.

### Mandatory source ownership

Every record in the knowledge plane has one indexed owner artifact, an optional precise source span, and a reverse-indexed set of every additional source artifact required to derive or validate it.

This invariant applies to entities, relations, facts, evidence, and diagnostics. Every source-derived projection, including semantic documents, embeddings, lexical entries, graph entries, and metrics, must preserve equivalent owner-artifact and source-version metadata for invalidation.

### Temporal validity

Knowledge records are versioned by workspace generation. Invalidating a record removes it from the current snapshot without physically deleting data still required by retained snapshots or paginated query executions.

Physical deletion is deferred to garbage collection after no retained snapshot can reference the record.

## Approved common envelope

Every canonical knowledge record uses this envelope:

```text
RecordEnvelope
  record_id
  category
  kind
  universal_kind
  facets[]
  schema_version
  workspace_id
  owner_artifact_id
  owner_artifact_version_id
  primary_source_span?
  valid_from_generation
  valid_to_generation?
  producer_id
  producer_version
  analysis_digest
  analysis_configuration_digest
  artifact_dependency_digest
  payload
  record_digest
```

### Field intent

- `record_id`: unique identity of this canonical record.
- `category`: universal structural category used by the core engine.
- `kind`: registered, namespaced, most precise semantic discriminator.
- `universal_kind`: exactly one registered `core:*` base kind for the same category, validated from the concrete kind definition.
- `facets`: deduplicated set of registered orthogonal structural traits allowed by the concrete kind definition.
- `schema_version`: version of the selected kind's payload contract.
- `workspace_id`: workspace whose source state produced the record.
- `owner_artifact_id`: mandatory primary artifact responsible for the record.
- `owner_artifact_version_id`: exact content occurrence from which the record was produced.
- `primary_source_span`: optional precise location inside the owner artifact.
- `valid_from_generation`: first workspace generation containing the record.
- `valid_to_generation`: optional first generation in which the record is no longer visible; absent while current.
- `producer_id`: registered plugin or core component that produced the record; free-form producer names are invalid.
- `producer_version`: producer version needed for provenance and cache invalidation.
- `analysis_digest`: immutable identity of the exact analyzer implementation that produced the record.
- `analysis_configuration_digest`: digest of every configuration input capable of changing the output.
- `artifact_dependency_digest`: digest of the complete canonically ordered `RecordArtifactDependencyDigestEntry` projection, which preserves every immutable semantic dependency field and excludes only materialization identity and later closure state.
- `payload`: data validated by the registered kind schema.
- `record_digest`: deterministic UCE digest of the immutable record state under `core:record_digest`; `valid_to_generation` is excluded by its positive payload binding.

The visibility interval is half-open: a record is visible at generation `g` exactly when `valid_from_generation <= g` and `valid_to_generation` is absent or `g < valid_to_generation`. `valid_to_generation` may move once from absent to a generation, never changes again, and is excluded from `record_digest`. All other fields are immutable.

A record stays open across consecutive generations only when every immutable field and every exact artifact dependency remain identical. A change to owner artifact version, source span, schema, producer, analyzer, configuration, dependencies, evidence, resolution, or payload closes the old record and opens another `record_id`. `valid_from_generation` distinguishes a later identical reappearance after deletion.

## Approved universal record categories

The canonical knowledge plane has exactly five structural categories:

```text
entity
relation
fact
evidence
diagnostic
```

Retrieval documents, embeddings, lexical entries, graph adjacency structures, aggregated metrics, and query manifests are rebuildable derived projections rather than canonical knowledge categories.

### Entity records

An `EntityRecord` represents something with semantic identity, lifecycle, references, or relation participation.

Examples include callables, types, variables, parameters, expressions that must be referenced, call sites, modules, endpoints, tests, configuration keys, and persistence entities. Urdira does not turn every syntax-tree node into an entity; a construct becomes an entity when another part of the model needs to identify or reference it.

### Relation records

A `RelationRecord` represents a typed, navigable connection between two or more semantic participants. Relations are first-class records rather than property-graph edges because they may require ordered roles, source locations, multiple possible targets, evidence, confidence, and temporal validity.

Examples include calls, imports, exports, containment, inheritance, implementation, reads, writes, returns, argument passing, data flow, test coverage, route handling, publishing, and subscription.

### Fact records

A `FactRecord` represents an independently addressable assertion about a subject and typed value when the assertion does not primarily describe a navigable connection between multiple entities.

A fact is appropriate when it needs its own evidence, provenance, confidence, lifecycle, multiple producers, or direct citation. Examples include purity conclusions, complexity values, inferred framework roles, constant values, or hot-path classifications.

### Evidence records

An `EvidenceRecord` explains why another record or conclusion exists. It may describe compiler resolution, exact syntax matching, type inference, Git metadata, framework recognition, semantic similarity, or a documented heuristic.

Evidence justifies knowledge and does not represent the code element itself.

### Diagnostic records

A `DiagnosticRecord` represents incomplete analysis, unsupported constructs, resolution failures, stale dependencies, plugin failures, or other conditions that affect completeness.

Diagnostics explain why knowledge may be incomplete or unavailable and contribute to completeness reporting in query responses.

### Inline payload properties versus facts

An intrinsic attribute remains inline in a record payload when all of the following hold:

- It has exactly one value for that record version.
- It is intrinsic to the record's representation.
- It is produced by the same extractor.
- It does not need independent evidence or confidence.
- It has no independent lifecycle.
- Other records do not need to reference the assertion itself.

Typical inline properties include names, qualified names, declaration kinds, modifiers, parameter positions, and literal kinds.

An assertion becomes a `FactRecord` when it can have multiple values or producers, represents an analysis conclusion, needs independent evidence or confidence, can be invalidated independently, or must be cited as a standalone claim.

### Canonical categories versus derived projections

A structure belongs to a derived projection when it introduces no independent semantic truth and exists only to optimize retrieval, ranking, traversal, aggregation, or pagination. It must be reproducible from canonical records and source artifacts.

The decision matrix is:

| Question | Representation |
|---|---|
| Does it need identity, lifecycle, references, or relation participation? | `EntityRecord` |
| Does it connect multiple participants in a navigable way? | `RelationRecord` |
| Is it an independently evidenced assertion about a subject and value? | `FactRecord` |
| Does it justify another record? | `EvidenceRecord` |
| Does it describe an analysis limitation or failure? | `DiagnosticRecord` |
| Is it only an intrinsic, single-valued attribute? | Inline payload property |
| Does it only optimize retrieval or execution? | Derived projection |

## Canonical schema and digest registries

Every canonical model, control value, plugin payload, projection payload, digest payload, and protocol value used for deterministic persistence has one immutable structural schema:

```text
CanonicalSchemaDefinition
  schema_id
  definition_revision
  schema_version
  description
  root_type
  type_definitions[]
  plugin_owner?
  lifecycle_state
  deprecated_since?
  retired_since?
  replacement_schema?

CanonicalNamedTypeDefinition
  type_name
  description
  type_expression

SchemaFieldDefinition
  field_name
  description
  presence
  value_type

SchemaVariantDefinition
  discriminator_value
  description
  fields[]
```

`CanonicalSchemaDefinition` fields:

| Field | Exact meaning |
|---|---|
| `schema_id` | Stable namespaced identifier of one logical root schema. It is never reused for a different meaning. |
| `definition_revision` | Positive monotonic revision of the complete registry definition, including documentation-only changes. |
| `schema_version` | Positive monotonic version of structural validation and canonical meaning. Any output-affecting structural change creates another version. |
| `description` | Normative bounded explanation of the root value and its boundary from adjacent schemas. |
| `root_type` | Exact `CanonicalTypeExpression` accepted at the schema root. |
| `type_definitions` | Canonically ordered set of locally named reusable types. Names are unique within this schema and the reference graph is acyclic. |
| `plugin_owner` | Immutable plugin ID owning a non-core schema; omitted for core. Its namespace must prefix `schema_id`. |
| `lifecycle_state` | `active`, `deprecated`, or `retired`. Retired schemas remain decodable while retained but cannot validate new output. |
| `deprecated_since` | First definition revision discouraging new use; required for deprecated or retired definitions. |
| `retired_since` | First definition revision forbidding new output; required exactly for retired definitions. |
| `replacement_schema` | Optional exact successor schema identifier; it is guidance and never an alias or implicit migration. |

`CanonicalNamedTypeDefinition.type_name` is an ASCII `snake_case` name unique inside the schema. `description` is normative and `type_expression` is the exact closed structural type bound to the name.

`SchemaFieldDefinition.field_name` is an exact ASCII `snake_case` map key. `description` is mandatory normative field documentation. `presence` is `required` or `optional`; defaults do not exist in canonical schemas. `value_type` is the exact accepted `CanonicalTypeExpression`.

`SchemaVariantDefinition.discriminator_value` is the exact enum value selected by its parent union. `description` defines the variant's meaning. `fields` is the canonically ordered closed set of fields in addition to the discriminator; it cannot redeclare the discriminator.

### CanonicalTypeExpression

```text
CanonicalTypeExpression =
  NullTypeExpression |
  BooleanTypeExpression |
  SafeIntegerTypeExpression |
  BigIntegerTypeExpression |
  Float64TypeExpression |
  ExactDecimalTypeExpression |
  TextTypeExpression |
  BytesTypeExpression |
  TimestampTypeExpression |
  DigestTypeExpression |
  EnumTypeExpression |
  SequenceTypeExpression |
  SetTypeExpression |
  OrderedSetTypeExpression |
  MapTypeExpression |
  RecordTypeExpression |
  UnionTypeExpression |
  SchemaReferenceTypeExpression

NullTypeExpression
  type_kind = null

BooleanTypeExpression
  type_kind = boolean

SafeIntegerTypeExpression
  type_kind = safe_integer
  minimum?
  maximum?

BigIntegerTypeExpression
  type_kind = big_integer
  minimum?
  maximum?

Float64TypeExpression
  type_kind = float64
  minimum?
  maximum?

ExactDecimalTypeExpression
  type_kind = exact_decimal
  minimum?
  maximum?
  scale_policy

TextTypeExpression
  type_kind = text
  minimum_code_point_count?
  maximum_code_point_count?

BytesTypeExpression
  type_kind = bytes
  minimum_byte_length?
  maximum_byte_length?

TimestampTypeExpression
  type_kind = timestamp
  earliest?
  latest?

DigestTypeExpression
  type_kind = digest
  allowed_hash_algorithms[]

EnumTypeExpression
  type_kind = enum
  values[]

SequenceTypeExpression
  type_kind = sequence
  element_type
  minimum_item_count?
  maximum_item_count?

SetTypeExpression
  type_kind = set
  element_type
  minimum_item_count?
  maximum_item_count?

OrderedSetTypeExpression
  type_kind = ordered_set
  element_type
  comparator_id
  comparator_version
  minimum_item_count?
  maximum_item_count?

MapTypeExpression
  type_kind = map
  value_type
  minimum_entry_count?
  maximum_entry_count?

RecordTypeExpression
  type_kind = record
  fields[]

UnionTypeExpression
  type_kind = union
  discriminator_field
  discriminator_description
  variants[]

SchemaReferenceTypeExpression
  type_kind = schema_reference
  reference_scope
  type_name
  schema_id?
  schema_version?
```

Every member is a closed record selected by `type_kind`:

| `type_kind` | Additional fields and exact contract |
|---|---|
| `null` | No additional fields. The only accepted value is `null`. |
| `boolean` | No additional fields. |
| `safe_integer` | Optional `minimum` and `maximum` `SafeInteger` bounds, inclusive. |
| `big_integer` | Optional `minimum` and `maximum` `BigInteger` bounds, inclusive. |
| `float64` | Optional finite `minimum` and `maximum` `Float64` bounds, inclusive. |
| `exact_decimal` | Optional `minimum` and `maximum` `ExactDecimal` bounds plus required `scale_policy`, `significant` or `insignificant`. |
| `text` | Optional non-negative `minimum_code_point_count` and `maximum_code_point_count`, inclusive. |
| `bytes` | Optional non-negative `minimum_byte_length` and `maximum_byte_length`, inclusive. |
| `timestamp` | Optional inclusive `earliest` and `latest` `Timestamp` values. |
| `digest` | Required non-empty `allowed_hash_algorithms` set. UCE v1 core schemas use only `sha256`. |
| `enum` | Required non-empty canonical set `values` of exact text values. |
| `sequence` | Required `element_type`; optional inclusive `minimum_item_count` and `maximum_item_count`. Order is semantic and duplicates are legal. |
| `set` | Required `element_type`; optional inclusive item-count bounds. Duplicate logical elements are invalid. |
| `ordered_set` | Required `element_type`, namespaced `comparator_id`, and positive `comparator_version`; optional inclusive item-count bounds. |
| `map` | Required `value_type`; optional inclusive `minimum_entry_count` and `maximum_entry_count`. Keys are exact text values and are unique. |
| `record` | Required canonical set `fields` of `SchemaFieldDefinition` values. Unknown fields are invalid. |
| `union` | Required `discriminator_field`, `discriminator_description`, and non-empty canonical set `variants` of `SchemaVariantDefinition` values. Discriminator values are unique. |
| `schema_reference` | Required `reference_scope`, `local` or `external`, and `type_name`. `schema_id` and `schema_version` are required exactly for `external` and forbidden for `local`. |

For every pair of optional bounds, the lower bound cannot exceed the upper bound. Item, entry, byte, and code-point limits are `SafeInteger` values. Schema references across the complete registry snapshot and local type references inside one schema form an acyclic graph. UCE structural constraints are portable and cannot invoke producer code.

### Canonical support registries

Schemas and digest recipes depend on four registries whose entries must be as immutable and collision-safe as record kinds. They are data, not executable callbacks embedded in Schema IR.

```text
HashAlgorithmDefinition
  hash_algorithm
  definition_revision
  schema_version
  description
  digest_byte_length
  specification_uri
  lifecycle_state
  deprecated_since?
  retired_since?
  replacement_hash_algorithm?

DigestDomainDefinition
  digest_domain
  definition_revision
  schema_version
  description
  plugin_owner?
  lifecycle_state
  deprecated_since?
  retired_since?
  replacement_digest_domain?

CanonicalComparatorDefinition
  comparator_id
  definition_revision
  schema_version
  comparator_version
  description
  sort_keys[]
  plugin_owner?
  lifecycle_state
  deprecated_since?
  retired_since?
  replacement_comparator?

CanonicalComparatorSortKey
  value_path
  comparison_mode
  direction
  absent_order

ExternalVerificationContractDefinition
  external_verification_contract_id
  definition_revision
  schema_version
  contract_version
  description
  verified_input_schema_id
  verified_input_schema_version
  terminal_digest_recipe_id
  terminal_digest_recipe_version
  verification_semantics
  plugin_owner?
  lifecycle_state
  deprecated_since?
  retired_since?
  replacement_external_verification_contract?

RuntimeComponentDefinition
  component_id
  definition_revision
  schema_version
  component_version
  component_contracts[]
  description
  behavior_digest
  plugin_owner?
  lifecycle_state
  deprecated_since?
  retired_since?
  replacement_component?

RuntimeComponentContractBinding
  component_kind
  contract_version
  configuration_schema_id?
  configuration_schema_version?

RuntimeComponentBuild
  runtime_component_build_id
  schema_version
  component_id
  component_version
  behavior_digest
  implementation_digest
  available_from
  selectable_to?
  removed_at?
```

`HashAlgorithmDefinition` fields:

| Field | Exact meaning |
|---|---|
| `hash_algorithm` | Stable lowercase ASCII algorithm name carried by `Digest`; an algorithm's mathematical meaning is immutable and a different algorithm requires another name. |
| `definition_revision` | Positive monotonic revision of the complete registry definition. |
| `schema_version` | Positive version of this definition-record schema; it does not version or reinterpret the algorithm. |
| `description` | Normative bounded description of the algorithm and accepted digest representation. |
| `digest_byte_length` | Exact positive output length. Every encoded and public digest must match it. |
| `specification_uri` | Immutable normative public specification identifying the algorithm exactly. |
| `lifecycle_state`, `deprecated_since`, `retired_since` | Core-owned lifecycle under the common revision rules. A retired algorithm remains verifiable for retained state but cannot be selected by new recipes. |
| `replacement_hash_algorithm` | Optional migration recommendation for a deprecated or retired algorithm; it never makes digests comparable across algorithms. |

Hash algorithms are core-owned cryptographic primitives. Plugins may select only an algorithm allowed by the negotiated UCE contract and cannot contribute `HashAlgorithmDefinition` values.

`DigestDomainDefinition` fields:

| Field | Exact meaning |
|---|---|
| `digest_domain` | Stable namespaced identity of one semantic digest space. Its meaning and owner are permanent. |
| `definition_revision` | Positive monotonic revision of the complete definition. |
| `schema_version` | Positive version of this definition-record schema. |
| `description` | Normative boundary distinguishing this digest space from adjacent domains. |
| `plugin_owner` | Owner of a non-core domain; omitted for core and namespace-equal to `digest_domain`. |
| `lifecycle_state`, `deprecated_since`, `retired_since` | Common immutable registry lifecycle. Retained recipes may continue to verify a retired domain. |
| `replacement_digest_domain` | Optional successor for new recipes; it never reinterprets existing digests. |

`CanonicalComparatorDefinition` fields:

| Field | Exact meaning |
|---|---|
| `comparator_id` | Stable namespaced comparator lineage. |
| `definition_revision` | Positive monotonic revision of the complete definition. |
| `schema_version` | Positive version of this definition-record schema. |
| `comparator_version` | Positive immutable version of the exact ordering behavior. Any ordering change creates another version. |
| `description` | Normative bounded explanation of the ordering and its intended element family. |
| `sort_keys` | Non-empty semantic sequence evaluated lexicographically. After all keys tie, complete UCE element bytes in ascending order are the mandatory final tie-breaker. |
| `plugin_owner` | Owner of a non-core comparator; omitted for core. |
| `lifecycle_state`, `deprecated_since`, `retired_since` | Common immutable registry lifecycle. Retained schemas keep their exact comparator version. |
| `replacement_comparator` | Optional successor comparator identifier for new schemas; never an alias. |

`CanonicalComparatorSortKey` fields:

| Field | Exact meaning |
|---|---|
| `value_path` | Canonical RFC 6901 JSON Pointer evaluated against the element; the empty pointer selects the complete element. |
| `comparison_mode` | Exact total-order primitive: `uce_bytes`, `text_utf8`, `bytes_lexicographic`, `safe_integer_numeric`, `big_integer_numeric`, `float64_numeric`, `exact_decimal_numeric`, `timestamp_chronological`, or `digest_lexicographic`. The selected path's schema type must be compatible. |
| `direction` | `ascending` or `descending` for this key only. |
| `absent_order` | `first`, `last`, or `forbidden`. `forbidden` requires the path to resolve for every element. |

Comparator evaluation is structural and portable. It cannot invoke producer code, locale rules, platform collation, or mutable configuration. `float64_numeric` operates only on finite values after negative-zero normalization. `exact_decimal_numeric` compares mathematical value and then significant scale when the schema declares scale significant. `digest_lexicographic` compares algorithm name and then digest bytes. Duplicate `OrderedSet` elements are rejected by complete logical equality; distinct elements that tie on every declared key remain ordered by the mandatory UCE-byte tie-breaker.

`ExternalVerificationContractDefinition` fields:

| Field | Exact meaning |
|---|---|
| `external_verification_contract_id` | Stable namespaced lineage of one installation- or activation-time provenance verifier. |
| `definition_revision` | Positive monotonic revision of the complete definition. |
| `schema_version` | Positive version of this definition-record schema. |
| `contract_version` | Positive immutable version of exact verification behavior. A behavior change creates another version. |
| `description` | Normative bounded purpose and trust boundary. |
| `verified_input_schema_id`, `verified_input_schema_version` | Exact closed input accepted after successful capture and provenance verification. |
| `terminal_digest_recipe_id`, `terminal_digest_recipe_version` | Exact recipe that hashes the verified input. |
| `verification_semantics` | Normative complete requirements for selecting, capturing, authenticating when applicable, and rejecting the input before hashing. |
| `plugin_owner` | Owner of a non-core contract; omitted for core. A plugin-owned verifier is usable only through its negotiated runtime contract. |
| `lifecycle_state`, `deprecated_since`, `retired_since` | Common immutable registry lifecycle. Retained references keep their exact contract version. |
| `replacement_external_verification_contract` | Optional successor identifier for new references; never an alias or implicit adapter. |

External verification is deliberately outside Schema IR because provenance checks may require trusted installation or activation logic. The registry definition pins its semantics and input; the snapshot-pinned resolution lock supplies an implementation that advertises that exact contract. Absence of a compatible retained implementation makes the affected state uninterpretable rather than approximately verified.

`RuntimeComponentDefinition` fields:

| Field | Exact meaning |
|---|---|
| `component_id` | Stable namespaced lineage used by a source provider, projection generator, embedding renderer, embedding segmenter, or embedding generator. |
| `definition_revision` | Positive monotonic revision of the complete definition. |
| `schema_version` | Positive version of this definition-record schema. |
| `component_version` | Exact normalized SemVer behavior release. One ID/version pair can resolve to only one `behavior_digest` in an index and retained history. |
| `component_contracts` | Non-empty set of `RuntimeComponentContractBinding` values, unique by `component_kind`, declaring every core behavioral interface implemented by this exact component release. |
| `description` | Normative bounded purpose and behavior boundary. |
| `behavior_digest` | Platform-neutral digest of the complete behavioral manifest: component identity, contract bindings, algorithms, configuration schemas, supported data formats, deterministic numeric requirements, and portable rules capable of changing semantic output. Executable binaries and native dependency bytes are excluded. |
| `plugin_owner` | Owning plugin for a non-core source provider or projection generator; omitted for core. It must be omitted when any component contract is `embedding_renderer`, `embedding_segmenter`, or `embedding_generator`, because all embedding components are core-owned. |
| `lifecycle_state`, `deprecated_since`, `retired_since` | Common immutable registry lifecycle. Retained snapshots keep exact component versions and implementations. |
| `replacement_component` | Optional successor identifier for new locks and profiles; never an alias. |

`RuntimeComponentContractBinding` fields:

| Field | Exact meaning |
|---|---|
| `component_kind` | Exactly `source_provider`, `projection_generator`, `embedding_renderer`, `embedding_segmenter`, or `embedding_generator`; it selects one core behavioral interface. |
| `contract_version` | Positive immutable version of that component-kind interface implemented by this exact component release. |
| `configuration_schema_id` | Optional exact closed canonical schema lineage accepted as declarative configuration by this binding. It is present exactly with `configuration_schema_version`. |
| `configuration_schema_version` | Optional exact positive schema version selected inside `configuration_schema_id`. A configuration value cannot override it. |

Keeping the contract version on the binding permits one exact implementation to serve several component kinds whose interfaces evolve independently. The configuration-schema fields are present or absent together. A model-pack `embedding_segmenter` or `embedding_generator` binding must provide them; an `embedding_renderer` binding omits them because its fixed input template is governed by the renderer contract. The pair is resolved from the exact component release and contract version, so a configuration value cannot select another schema revision dynamically.

`RuntimeComponentBuild` fields:

| Model.field | Exact meaning |
|---|---|
| `RuntimeComponentBuild.runtime_component_build_id` | Stable identity of one exact distributable executable build under a component behavior release. |
| `RuntimeComponentBuild.schema_version` | Positive version of this closed local build-registry schema. |
| `RuntimeComponentBuild.component_id` | Exact `RuntimeComponentDefinition.component_id` implemented by the build. |
| `RuntimeComponentBuild.component_version` | Exact platform-neutral behavior release implemented by the build. |
| `RuntimeComponentBuild.behavior_digest` | Exact platform-neutral definition digest implemented by the build. |
| `RuntimeComponentBuild.implementation_digest` | Digest of the complete executable build manifest, including executable bytes, native assets, dependency closure, build identity, and the behavior digest it claims. |
| `RuntimeComponentBuild.available_from` | Time the verified local build became available for exact execution. |
| `RuntimeComponentBuild.selectable_to` | One-way boundary after which new bindings cannot select this build; omitted while it is the current selectable build. |
| `RuntimeComponentBuild.removed_at` | Time executable bytes became unavailable locally; omitted while retained execution remains possible. Removal is forbidden while any retained binding roots the build. |

The model-pack format never names a `runtime_component_build_id` or `implementation_digest`. The Urdira distribution or an explicitly installed plugin package supplies platform-appropriate builds separately. Before publication, Urdira verifies that a build's identity, component version, behavior digest, and complete contract set match its platform-neutral definition. Under one exact local engine state, at most one build for a component ID, version, and behavior digest is selectable for new bindings; older builds may remain installed only for retained work.

Plugin contributions may contain only platform-neutral runtime component definitions whose complete `component_contracts` set is a subset of `source_provider` and `projection_generator`; their executable builds remain package and local-runtime records. Components implementing `embedding_renderer`, `embedding_segmenter`, or `embedding_generator` and all of their builds are core-owned and shipped with Urdira, so their definitions always omit `plugin_owner`. A model pack may reference compatible component behavior identities and provide declarative configuration, but cannot register or contain an executable build.

Every `source_provider + source_provider_version`, projection `generator + generator_version`, embedding `generator + generator_version`, `renderer_id + renderer_version`, and `segmenter_id + segmenter_version` pair resolves to exactly one platform-neutral `RuntimeComponentDefinition` in the snapshot-pinned registry and requires the corresponding component-kind binding. The field names keep their domain terminology but use the definition's `component_id + component_version` coordinates. The same pair with another `behavior_digest` is a definition collision. Execution additionally resolves one exact local `RuntimeComponentBuild`; physical computation reuse keys on its `implementation_digest`.

### DigestRecipeDefinition

Every stored or transferred digest field is governed by exactly one computation recipe or one reference definition. A computed field creates a digest from a canonical envelope:

```text
DigestRecipeDefinition
  digest_recipe_id
  definition_revision
  schema_version
  recipe_version
  target_schema_id
  target_schema_version
  target_field
  digest_domain
  canonical_encoding_version
  hash_algorithm
  payload_schema_id
  payload_schema_version
  verified_input_schema_id?
  verified_input_schema_version?
  payload_binding
  plugin_owner?
  lifecycle_state
  deprecated_since?
  retired_since?
  replacement_digest_recipe?

DigestPayloadBinding =
  ScalarDigestPayloadBinding |
  RecordDigestPayloadBinding

ScalarDigestPayloadBinding
  binding_kind = scalar
  source_path

RecordDigestPayloadBinding
  binding_kind = record
  field_bindings[]

DigestPayloadFieldBinding
  payload_field
  source_path
  value_mode
  referenced_digest_recipe_id?
  referenced_digest_recipe_version?

DigestComputationContext
  target
  verified_input?
```

`DigestRecipeDefinition` fields:

| Field | Exact meaning |
|---|---|
| `digest_recipe_id` | Stable namespaced identity of one digest purpose. It is included in the digest envelope. |
| `definition_revision` | Positive monotonic revision of the complete registry definition. Metadata-only changes increase it. |
| `schema_version` | Positive version of this recipe-definition record schema, independent from the recipe's output semantics. |
| `recipe_version` | Positive immutable version of the exact preimage construction. Any output-affecting change creates another version. |
| `target_schema_id`, `target_schema_version` | Exact schema containing the governed digest field. |
| `target_field` | Canonical RFC 6901 JSON Pointer to the one `Digest` field computed by this recipe. |
| `digest_domain` | Exact registered `DigestDomainDefinition` included in the digest envelope. It must be core-owned, owned by this recipe's plugin, or owned by a mandatory declared dependency. |
| `canonical_encoding_version` | Exact UCE version used for the envelope and payload. |
| `hash_algorithm` | Exact active or retained `HashAlgorithmDefinition` applied to the canonical envelope. UCE v1 requires `sha256`. |
| `payload_schema_id`, `payload_schema_version` | Exact scalar or closed record schema of the envelope payload. |
| `verified_input_schema_id`, `verified_input_schema_version` | Exact schema of an external verified input required by the computation; present together or omitted together. |
| `payload_binding` | Complete deterministic construction of that payload from the target value and exact immutable references. |
| `plugin_owner` | Owning plugin for a non-core recipe; omitted for core and namespace-equal to the recipe identifier. Referenced domains may additionally be core- or dependency-owned. |
| `lifecycle_state` | `active`, `deprecated`, or `retired`; retained versions remain verifiable. |
| `deprecated_since`, `retired_since` | Lifecycle revision markers following the common registry rules. |
| `replacement_digest_recipe` | Optional successor recipe identifier; it never reinterprets an existing digest. |

`DigestComputationContext.target` is the complete schema-valid value containing the target digest field. `verified_input` is present exactly when the recipe declares a verified-input schema and contains that exact validated value. A binding source path begins with `/target` or `/verified_input`; the latter is invalid when no verified input is declared.

`ScalarDigestPayloadBinding.source_path` is a canonical JSON Pointer on `DigestComputationContext` selecting the exact scalar value used as payload. `RecordDigestPayloadBinding.field_bindings` is a non-empty canonical set containing exactly one binding for every required payload field and no binding for an undeclared field.

`DigestPayloadFieldBinding.payload_field` is one top-level field in the payload record. `source_path` selects the exact source value or immutable reference from the computation context. `value_mode` is `direct_value` or `referenced_digest`. The referenced recipe identifier and version are required exactly for `referenced_digest` and forbidden for `direct_value`. Recipe references form an acyclic graph. A binding cannot select its own target digest field.

Every recipe hashes the exact envelope defined by [Urdira Canonical Encoding](../serialization/urdira-canonical-encoding.md). Digest equality never assigns or reopens a lifecycle identity.

### DigestReferenceDefinition

A reference field copies and pins a digest computed elsewhere; it never hashes that digest again:

```text
DigestReferenceDefinition
  digest_reference_id
  definition_revision
  schema_version
  target_schema_id
  target_schema_version
  target_field
  source_digest_recipe_id
  source_digest_recipe_version
  reference_kind
  locator_bindings[]
  external_verification_contract_id?
  external_verification_contract_version?
  plugin_owner?
  lifecycle_state
  deprecated_since?
  retired_since?
  replacement_digest_reference?

DigestLocatorBinding
  target_source_path
  source_key_path
```

`DigestReferenceDefinition` fields:

| Field | Exact meaning |
|---|---|
| `digest_reference_id` | Stable namespaced identity of one digest-field reference contract. |
| `definition_revision` | Positive monotonic revision of the complete registry definition. |
| `schema_version` | Positive version of this reference-definition record schema. |
| `target_schema_id`, `target_schema_version`, `target_field` | Exact schema and RFC 6901 field path containing the copied `Digest`. |
| `source_digest_recipe_id`, `source_digest_recipe_version` | Exact terminal computation recipe whose output is copied and verified. |
| `reference_kind` | `model` for a registry- or index-addressable source object, or `external_asset` for bytes verified by an installation or activation contract. |
| `locator_bindings` | Complete canonical set mapping fields on the holder to key fields on the authoritative source model. Non-empty exactly for `model`. |
| `external_verification_contract_id`, `external_verification_contract_version` | Exact verifier contract required together for `external_asset` and forbidden for `model`. |
| `plugin_owner` | Owning plugin for a non-core definition; omitted for core. |
| `lifecycle_state`, `deprecated_since`, `retired_since`, `replacement_digest_reference` | Immutable lifecycle and optional successor metadata following common registry rules. |

Each `DigestLocatorBinding.target_source_path` is a canonical JSON Pointer on the field holder. `source_key_path` is the exact JSON Pointer on the authoritative source schema. All locator bindings must match one unique immutable source object before the copied digest is accepted.

A model locator may use the copied digest itself as an untrusted content address when natural coordinates such as a package version are not unique. That lookup never proves equality: after locating the candidate source object, Urdira independently validates its schema and recomputes its authoritative digest recipe before comparing bytes. A missing, ambiguous, or mismatched content-addressed lookup fails verification.

Every `Digest` field is the target of exactly one `DigestRecipeDefinition` or `DigestReferenceDefinition`, never both. Reference chains terminate at a computation recipe and are acyclic. A model reference requires exact equality with the located source digest. An external-asset reference requires successful verification under its exact immutable verifier contract.

### Canonical encoding error and conformance models

```text
CanonicalEncodingErrorCodeDefinition
  code
  definition_revision
  schema_version
  description
  allowed_phases[]
  details_schema
  lifecycle_state
  deprecated_since?
  retired_since?
  replacement_code?

CanonicalEncodingConformanceCase
  case_id
  corpus_revision
  input_kind
  logical_input?
  encoded_input_hex?
  schema_id
  schema_version
  digest_recipe_id?
  recipe_version?
  expected_outcome
  expected_cbor_hex?
  expected_digest_text?
  expected_error_code?
```

`CanonicalEncodingErrorCodeDefinition.code` is a stable core-owned error cause. `definition_revision` and `schema_version` follow the common registry rules. `description` defines the exact trigger and non-meaning. `allowed_phases` is a non-empty set drawn from `decode`, `normalize`, `schema_validation`, `recipe_validation`, `hash`, and `verify`. `details_schema` is closed. Lifecycle fields follow the common registry rules. UCE v1 does not allow plugins to extend this low-level error registry; plugin validation maps failures to these core causes. Initial definitions are authoritative in [Core canonical encoding errors](../serialization/core-canonical-encoding-error-codes.md).

`CanonicalEncodingConformanceCase.case_id` is stable within the immutable positive `corpus_revision`. `input_kind` is `logical_value` or `encoded_bytes`; exactly the corresponding `logical_input` or lowercase even-length `encoded_input_hex` is present. The exact schema is always required. Recipe identifier and version are present together exactly when digest behavior is under test. `expected_outcome` is `success` or `error`. Success requires `expected_cbor_hex`, requires `expected_digest_text` exactly when a recipe is selected, and omits `expected_error_code`. `expected_digest_text` is `Text` matching the selected hash algorithm's one canonical public `Digest` projection; the harness parses it to `Digest` before byte-for-byte comparison, so it is an oracle literal rather than another computed or referenced digest field. Error requires `expected_error_code` and omits success fields. Published cases never change.

## Record-kind registry

Urdira uses one precise concrete kind, one universal base kind, and zero or more orthogonal structural facets. It does not force language concepts into one inheritance tree and does not accept unvalidated free-form tags.

Each record kind is registered through:

```text
RecordKindDefinition
  kind
  category
  definition_revision
  schema_version
  description
  payload_schema
  universal_kind
  required_facets[]
  allowed_facets[]
  relation_definition?
  plugin_owner?
  lifecycle_state
  deprecated_since?
  retired_since?
  replacement_kind?
```

- `kind` is the stable concrete namespaced discriminator selected by `RecordEnvelope.kind`.
- `category` is exactly one of the five universal record categories and must equal the record envelope category.
- `definition_revision` is the positive monotonic revision of the complete registry definition. It increases for every published change, including metadata-only changes, and is never reused for this kind.
- `schema_version` is the positive monotonic version of the record-validation and payload contract. Metadata-only definition changes retain it.
- `description` defines the kind's exact semantics and its distinction from adjacent kinds.
- `payload_schema` is the closed schema for the record payload selected by this concrete kind.
- `universal_kind` is exactly one core base kind in the same category. A core kind maps to itself.
- `required_facets` is the deduplicated set every record of this kind must contain.
- `allowed_facets` is the deduplicated superset from which context-dependent facets may be selected. It includes every required facet.
- `relation_definition` is required for relation kinds and forbidden for other categories.
- `plugin_owner` is the immutable globally unique `plugin_id` that owns the definition and is omitted for core definitions.
- `lifecycle_state` is `active`, `deprecated`, or `retired` and controls whether new canonical records may use this kind.
- `deprecated_since` is required for every `deprecated` or `retired` definition and identifies the first `definition_revision` discouraging new use; it is omitted for `active` definitions.
- `retired_since` is required exactly when `lifecycle_state` is `retired` and identifies the first revision forbidding new records.
- `replacement_kind` identifies the optional semantic replacement for a deprecated or retired kind and is omitted otherwise. It is guidance, not an alias.

Facets are registered through:

```text
FacetDefinition
  facet
  definition_revision
  schema_version
  description
  applicable_categories[]
  applicable_universal_kinds[]
  implied_facets[]
  incompatible_facets[]
  plugin_owner?
  lifecycle_state
  deprecated_since?
  retired_since?
  replacement_facet?
```

- `facet` is the stable namespaced structural trait.
- `definition_revision` is the positive monotonic revision of the complete facet definition and increases for every published change.
- `schema_version` is the positive monotonic version of the facet-assignment validation contract. Metadata-only definition changes retain it.
- `description` defines the exact intrinsic boolean property asserted by membership.
- `applicable_categories` is the non-empty closed set of record categories that may carry the facet.
- `applicable_universal_kinds` is the non-empty closed set of compatible universal base kinds.
- `implied_facets` is the deduplicated set automatically required when this facet is present.
- `incompatible_facets` is the symmetric set of facets that cannot coexist on one record.
- `plugin_owner` is the immutable globally unique `plugin_id` of the defining plugin and is omitted for core facets.
- `lifecycle_state` is `active`, `deprecated`, or `retired` and controls whether new records may assert this facet.
- `deprecated_since` is required for every `deprecated` or `retired` definition and identifies the first discouraging `definition_revision`; it is omitted for `active` definitions.
- `retired_since` is required exactly for `retired` and identifies the first revision forbidding new facet assertions.
- `replacement_facet` identifies the optional semantic replacement for a deprecated or retired facet and is omitted otherwise. It is guidance, not an alias.

A facet may be used only for an intrinsic, boolean, single-version property that needs no independent evidence, confidence, lifecycle, or typed value. Anything outside that boundary is represented as payload data, a fact, or a relation.

Core operations depend only on universal kinds, core facets, and registered semantic values. Plugin-specific kinds preserve language precision without changing the public engine.

#### Agent-facing kind selection

```text
KindDescriptor
  kind
  universal_kind
  facets[]

KindSelector
  kinds?
  universal_kinds?
  all_facets?
  any_facets?
  excluded_facets?
```

`KindDescriptor` fields:

- `kind` is the record's concrete, most precise namespaced kind.
- `universal_kind` is the single core base kind through which language-agnostic operations interpret the record.
- `facets` is the complete deduplicated set of facets asserted for that record version.

`KindSelector` fields:

- `kinds` is an optional non-empty array matching any listed concrete kind.
- `universal_kinds` is an optional non-empty array matching any listed universal base kind.
- `all_facets` is an optional non-empty array requiring every listed facet.
- `any_facets` is an optional non-empty array requiring at least one listed facet.
- `excluded_facets` is an optional non-empty array rejecting a record when any listed facet is present.

Different selector fields combine with logical AND. Omission means no restriction for that dimension. Present empty arrays are invalid. Every value must exist in the snapshot-pinned registry before execution. `KindDescriptor` accompanies every agent-visible canonical record so an agent never needs another call merely to learn its universal mapping.

#### Registered semantic value definitions

```text
SemanticRoleDefinition
  role
  definition_revision
  schema_version
  description
  allowed_subject_universal_kinds[]
  allowed_subject_facets[]
  implied_roles[]
  incompatible_roles[]
  plugin_owner?
  lifecycle_state
  deprecated_since?
  retired_since?
  replacement_role?

MetricDefinition
  metric
  definition_revision
  schema_version
  description
  value_type
  unit
  allowed_subject_universal_kinds[]
  supported_aggregations[]
  plugin_owner?
  lifecycle_state
  deprecated_since?
  retired_since?
  replacement_metric?

EffectDefinition
  effect
  definition_revision
  schema_version
  description
  allowed_subject_universal_kinds[]
  propagation_policy
  implied_effects[]
  plugin_owner?
  lifecycle_state
  deprecated_since?
  retired_since?
  replacement_effect?
```

`SemanticRoleDefinition` fields:

- `role` is the stable namespaced value stored by a `core:semantic_role` fact.
- `definition_revision` is the positive monotonic revision of the complete role definition and increases for every published change.
- `schema_version` is the positive monotonic version of the stored role-value validation contract. Metadata-only definition changes retain it.
- `description` defines the exact architectural or framework role.
- `allowed_subject_universal_kinds` is the non-empty set of universal entity kinds that may hold the role.
- `allowed_subject_facets` is the set of structural facets that may constrain eligible subjects; empty means no facet constraint.
- `implied_roles` is the deduplicated, acyclic set of registered roles that always follow from this role. Plugin roles may use it to imply sound core roles; an empty set declares no universal implication.
- `incompatible_roles` is the symmetric set of roles that cannot simultaneously be confirmed for one subject under the same scope.
- `plugin_owner` is the immutable globally unique `plugin_id` of a plugin-defined role and is omitted for core roles.
- `lifecycle_state` is `active`, `deprecated`, or `retired` and controls whether new facts may store this role.
- `deprecated_since` and `retired_since` follow the common definition-revision presence rules.
- `replacement_role` is the optional semantic replacement for a deprecated or retired role and never acts as an alias.

`MetricDefinition` fields:

- `metric` is the stable namespaced metric identifier stored by a `core:metric` fact.
- `definition_revision` is the positive monotonic revision of the complete metric definition and increases for every published change.
- `schema_version` is the positive monotonic version of the stored metric-value validation contract. Metadata-only definition changes retain it.
- `description` defines the measurement and required calculation method.
- `value_type` is the exact numeric representation, initially `integer` or `number`.
- `unit` is the stable unit identifier; `count` is used for dimensionless counts.
- `allowed_subject_universal_kinds` is the non-empty set of entity kinds that may be measured.
- `supported_aggregations` is the closed set of mathematically valid aggregations for this metric.
- Allowed aggregation values are `sum`, `minimum`, `maximum`, and `arithmetic_mean`; an empty set means that core aggregation is forbidden.
- `plugin_owner` is the immutable globally unique `plugin_id` of a plugin-defined metric and is omitted for core metrics. A producer emits an existing metric identifier when its algorithm, unit, type, subject scope, and aggregation semantics are exactly equivalent; it must not register an alias with weaker or different semantics.
- `lifecycle_state` is `active`, `deprecated`, or `retired` and controls whether new facts may store this metric.
- `deprecated_since` and `retired_since` follow the common definition-revision presence rules.
- `replacement_metric` is the optional documented successor for a deprecated or retired metric and never acts as an alias or assertion of mathematical equivalence.

`EffectDefinition` fields:

- `effect` is the stable namespaced effect value stored by a `core:effect` fact.
- `definition_revision` is the positive monotonic revision of the complete effect definition and increases for every published change.
- `schema_version` is the positive monotonic version of the stored effect-value validation contract. Metadata-only definition changes retain it.
- `description` defines the observable semantic effect.
- `allowed_subject_universal_kinds` is the non-empty set of entities to which the effect may be attributed.
- `propagation_policy` states whether core queries may propagate the effect through `none`, `call`, `data_flow`, or `call_and_data_flow` traversal. Propagated conclusions remain derived and retain evidence paths.
- `implied_effects` is the deduplicated, acyclic set of registered effects that always follow from this effect. Plugin effects may use it to imply sound core effects; an empty set declares no universal implication.
- `plugin_owner` is the immutable globally unique `plugin_id` of a plugin-defined effect and is omitted for core effects.
- `lifecycle_state` is `active`, `deprecated`, or `retired` and controls whether new facts may store this effect.
- `deprecated_since` and `retired_since` follow the common definition-revision presence rules.
- `replacement_effect` is the optional semantic replacement for a deprecated or retired effect and never acts as an alias.

For `SemanticRoleDefinition`, `MetricDefinition`, and `EffectDefinition`, `deprecated_since` is required when `lifecycle_state` is `deprecated` or `retired` and is omitted for `active`; it identifies the first discouraging `definition_revision`. `retired_since` is required exactly for `retired` and identifies the first revision forbidding new values. The corresponding replacement field may be present only for `deprecated` or `retired` and is optional because not every concept has a truthful successor.

#### Languages, capabilities, constructs, and limitations

```text
LanguageDefinition
  language_id
  definition_revision
  schema_version
  description
  display_name
  aliases[]
  lifecycle_state
  deprecated_since?
  retired_since?
  replacement_language_id?

LanguageDefinitionSupply
  language_id
  definition_revision
  definition_digest
  supplier_plugin_id
  supplier_plugin_version

CapabilityContractDefinition
  capability
  capability_contract_version
  definition_revision
  schema_version
  description
  allowed_precisions[]
  allowed_record_categories[]
  allowed_universal_kinds[]
  allowed_evidence_bases[]
  allowed_claim_classes[]
  partition_key_schema?
  dependency_obligations[]
  confirmed_claims_allowed
  completeness_semantics
  plugin_owner?
  lifecycle_state
  deprecated_since?
  retired_since?
  replacement_capability?

CapabilityDependencyObligation
  dependency_basis
  required
  transitive_artifact_closure?
  fallback_scope

CapabilityCompletenessSemantics
  complete_requires_authoritative_replacement
  partial_allowed
  unknown_allowed
  unsupported_allowed
  non_complete_reason_required
  affected_scope_rule

ConstructClassDefinition
  construct_code
  definition_revision
  schema_version
  description
  applicable_capabilities[]
  plugin_owner?
  lifecycle_state
  deprecated_since?
  retired_since?
  replacement_construct_code?

CapabilityLimitationDefinition
  limitation_code
  definition_revision
  schema_version
  description
  allowed_capabilities[]
  allowed_statuses[]
  agent_guidance
  plugin_owner?
  lifecycle_state
  deprecated_since?
  retired_since?
  replacement_limitation_code?
```

`LanguageDefinition` is a shared registry family and deliberately has no `plugin_owner`. `language_id` is the canonical stored identifier; aliases are bounded discovery terms only. One alias may match several languages and discovery returns every candidate, while exact lookup accepts only `language_id`. Artifacts, capability declarations, structural filters, embedding profiles, and canonical records never store aliases.

A plugin may supply or reference a language definition. Several contributions may supply the same `language_id + definition_revision` only when the complete canonical definition bytes and digest are identical. The registry stores one definition and a `LanguageDefinitionSupply` per supplier. Any differing field or digest under the same coordinate rejects activation atomically. A reference without supply must resolve through core or an explicit mandatory dependency. Embedding profiles may activate only when every explicit language ID is active in the assembled registry.

`CapabilityContractDefinition.capability + capability_contract_version` is the behavioral coordinate; `definition_revision` selects its exact complete metadata occurrence. Plugin-owned capabilities are namespaced; plugins ordinarily reference core capability contracts without redefining them. `partition_key_schema` is an optional external Schema IR reference governing `ReplacementScope.partition_key`. Every replacement, construct applicability, and limitation applicability uses `CapabilityRequirement`, so activation resolves it to exact contract versions rather than floating silently.

`CapabilityDependencyObligation.dependency_basis` is `owner_artifact`, `direct_artifact_input`, `record_input`, `reference_target`, `resolution_context`, or `evidence_source`. `transitive_artifact_closure` is required exactly for `record_input`; it must be true in the initial contract. `fallback_scope` is `none`, `plugin_partition`, `plugin`, or `workspace`. A required basis that cannot be proven uses only its declared conservative fallback or rejects output.

`CapabilityCompletenessSemantics.affected_scope_rule` is `exact`, `exact_if_enumerable`, or `may_be_unenumerable_with_reason`. Its booleans close the statuses legal for that capability, and every non-complete status requires a registered reason when `non_complete_reason_required` is true. `complete_requires_authoritative_replacement` forbids a complete claim that does not cover every authorized replacement scope.

`ConstructClassDefinition` gives a registered stable meaning to construct codes used by static coverage exclusions. `CapabilityLimitationDefinition` gives each limitation code one exact trigger boundary, legal versioned capabilities, legal non-complete statuses, and concise agent guidance. Their lifecycle and replacement presence rules are the common immutable registry rules. Neither family changes query behavior.

#### Registered operational and derivation values

Every namespaced value emitted by a plugin and interpreted by the core has an explicit immutable registry definition:

```text
DependencyRoleDefinition
  dependency_role
  definition_revision
  schema_version
  description
  invalidation_semantics
  plugin_owner?
  lifecycle_state
  deprecated_since?
  retired_since?
  replacement_dependency_role?

ProjectionKindDefinition
  projection_kind
  definition_revision
  schema_version
  description
  payload_schema
  generator_contract_version
  plugin_owner?
  lifecycle_state
  deprecated_since?
  retired_since?
  replacement_projection_kind?

LifecycleReasonCodeDefinition
  reason_code
  definition_revision
  schema_version
  description
  applicable_domains[]
  plugin_owner?
  lifecycle_state
  deprecated_since?
  retired_since?
  replacement_reason_code?

CompletenessReasonDefinition
  reason_code
  definition_revision
  schema_version
  description
  allowed_statuses[]
  affected_capabilities[]
  agent_guidance
  plugin_owner?
  lifecycle_state
  deprecated_since?
  retired_since?
  replacement_reason_code?

SemanticSectionKindDefinition
  section_kind
  definition_revision
  schema_version
  description
  allowed_origin_kinds[]
  agent_guidance
  plugin_owner?
  lifecycle_state
  deprecated_since?
  retired_since?
  replacement_section_kind?

SemanticReasonDefinition
  reason_code
  definition_revision
  schema_version
  description
  allowed_eligibility_statuses[]
  allowed_coverage_statuses[]
  completeness_reason_code?
  agent_guidance
  plugin_owner?
  lifecycle_state
  deprecated_since?
  retired_since?
  replacement_reason_code?

EmbeddingProfile
  embedding_profile_id
  definition_revision
  schema_version
  description
  embedding_contract_version
  model_provider_id
  model_id
  model_revision
  model_identity_digest
  tokenizer_id
  tokenizer_revision
  tokenizer_digest
  document_input_contract
  query_input_contract
  segmentation_contract
  maximum_document_tokens
  maximum_query_tokens
  dimensions
  element_type
  vector_encoding
  normalization
  distance_metric
  language_support
  supported_query_classes[]
  supported_content_classes[]
  agent_guidance
  lifecycle_state
  deprecated_since?
  retired_since?
  replacement_embedding_profile_id?
  profile_digest

EmbeddingInputContract
  renderer_id
  renderer_version
  template_digest
  input_purpose

EmbeddingSegmentationContract
  segmenter_id
  segmenter_version
  configuration_digest

EmbeddingLanguageSupport
  mode
  language_ids[]
  supports_unclassified_text

EvidenceAssumptionDefinition
  assumption_code
  definition_revision
  schema_version
  description
  satisfaction_contract
  agent_guidance
  plugin_owner?
  lifecycle_state
  deprecated_since?
  retired_since?
  replacement_assumption_code?

EvidenceExplanationDefinition
  explanation_code
  definition_revision
  schema_version
  description
  allowed_bases[]
  allowed_derivations[]
  agent_guidance
  plugin_owner?
  lifecycle_state
  deprecated_since?
  retired_since?
  replacement_explanation_code?
```

- `DependencyRoleDefinition.dependency_role` is the stable value stored by `RecordArtifactDependency` and proposed dependencies. `invalidation_semantics` defines exactly why a change to the dependency artifact may invalidate the owning record.
- `ProjectionKindDefinition.projection_kind` selects the closed derived-projection payload schema. `generator_contract_version` is the exact `projection_generator` behavioral contract a resolved runtime component must implement independently from its implementation version; the selected component binding's `contract_version` must equal it.
- `LifecycleReasonCodeDefinition.reason_code` is used only in the domains listed by `applicable_domains`: `artifact_absence`, `artifact_change`, `record_open`, `record_closure`, `projection_open`, `projection_close`, `retention_pin`, `retention_release`, `snapshot_expiration`, `lease_release`, `model_pack_removal`, or `embedding_profile_supply_release`.
- `CompletenessReasonDefinition.reason_code` explains `partial`, `unknown`, `unsupported`, or `stale` coverage. `allowed_statuses` is a non-empty subset of those values, and `affected_capabilities` is the closed capability set to which the reason may apply.
- `SemanticSectionKindDefinition.section_kind` selects a stable namespaced section meaning. `allowed_origin_kinds` is a non-empty subset of `source_text`, `record_rendering`, and `artifact_metadata`.
- `SemanticSectionKindDefinition.replacement_section_kind` is an optional registered successor allowed only for deprecated or retired section kinds; it does not reinterpret retained sections.
- `SemanticReasonDefinition.reason_code` explains semantic eligibility or artifact-coverage state. `allowed_eligibility_statuses` is a subset of `excluded`, `unsupported`, and `failed`; `eligible` never has a reason. `allowed_coverage_statuses` is a subset of `pending`, `excluded`, `unsupported`, and `failed`; `covered` never has a reason. At least one allowed-status set is non-empty. `completeness_reason_code` is required exactly when the reason degrades query completeness and selects a compatible `CompletenessReasonDefinition`.
- `SemanticReasonDefinition.replacement_reason_code` is an optional registered successor allowed only when the semantic reason is deprecated or retired.
- `EmbeddingProfile.embedding_profile_id` permanently identifies one immutable vector space. Any change capable of changing segmentation, model input, vector bytes, language claims, normalization, or distance semantics requires a new identifier rather than a definition revision.
- `EmbeddingInputContract.input_purpose` is `document` or `query`; the containing field and value must agree. Renderer identity, version, and template digest make asymmetric retrieval inputs reproducible.
- `EmbeddingSegmentationContract` pins the registered segmenter implementation and every behavior-affecting configuration value by digest.
- The document and query renderer components require `embedding_renderer` bindings, the segmenter requires an `embedding_segmenter` binding, and every materialization or query-vector generator requires an `embedding_generator` binding. Each selected binding's `contract_version` must equal the profile's `embedding_contract_version`; no implicit compatibility range or adapter is inferred.
- Every embedding profile and every referenced renderer, segmenter, generator, inference runtime, tokenizer asset, and model asset is core-owned. Profiles may be shipped with Urdira or installed through an integrity-verified data-only Urdira model pack, but never through a language or framework plugin. Model packs may contain immutable weights, tokenizer data, templates, declarative configurations, profile definitions, provenance, licenses, and evaluation metadata. They cannot contain executable code, bytecode, native libraries, scripts, command hooks, callbacks, or runtime implementations. Every executable component referenced by a pack must already exist in and be compatible with the exact Urdira engine version. Every selected component and asset is locally available, digest-verified, and pinned before activation.
- Model-pack identity is delivery-independent. A deterministic canonical manifest commits to the complete asset set, including each asset's content digest, exact decoded byte length, media type, and semantic role. Every declared asset is mandatory for that pack identity. The same logical pack may arrive as a complete offline bundle or through an explicitly requested online installer, but URLs, mirrors, credentials, compression, archive layout, and other delivery metadata are outside the canonical manifest and never affect identity. Every declared blob must exist and verify in the local content-addressed store before atomic activation; semantic work never performs lazy or query-time downloads.
- Model-pack authenticity is deliberately outside the protocol. No signature, key, trust-store, certificate, or publisher-authentication field belongs to the canonical model. Explicit administrative installation authorizes one exact manifest digest. Digest equality proves exact bytes only; declared publisher, provenance, license, evaluation, catalog, and source-location values are unauthenticated metadata. A second manifest digest claiming the same `model_pack_id + model_pack_version` is an activation collision rather than an upgrade, replacement, or trust-ranking decision.
- Model-pack identity is the triple `model_pack_id + model_pack_version + manifest_digest`. `model_pack_id` is a stable canonical namespaced identifier whose uniqueness is enforced within an installation without implying authenticated ownership. `model_pack_version` is normalized SemVer 2.0.0 and permanently identifies one immutable manifest meaning. `manifest_digest` is computed from the complete canonical manifest with the digest field itself omitted. Reinstalling the same triple is idempotent. The same ID and version with another digest is a hard collision; the same digest under different coordinates is not the same logical pack even when assets are shared physically.
- Any change to a profile definition, asset membership, asset metadata, runtime requirement, license, provenance statement, evaluation metadata, or other canonical manifest field requires a new `model_pack_version`. Delivery locators and transport packaging remain outside the canonical manifest and may change without creating another logical pack version.
- The canonical model-pack manifest embeds a non-empty complete `embedding_profiles` set of full `EmbeddingProfile` definitions. Profiles are not stored in another asset, loaded through a path, or resolved from delivery metadata. The set is duplicate-free and canonically ordered by `embedding_profile_id`, so producer array order cannot change `manifest_digest`. During installation Urdira recomputes every `profile_digest`, validates the entire definition against the manifest schema and exact engine contracts, and verifies that every referenced model, tokenizer, template, configuration, and component requirement is satisfied by the same pack plus the selected engine.
- Two installed packs may embed the same `embedding_profile_id` only when their complete canonical `EmbeddingProfile` definitions, recomputed `profile_digest`, all four canonically ordered `ModelPackRuntimeRequirement` entries, and both canonical `ModelPackRuntimeConfiguration` values are identical; the core registry then deduplicates the complete executable profile binding while retaining both pack references for lifecycle accounting. A different profile digest, runtime requirement, or runtime configuration under the same profile ID is a hard activation collision. Removing one pack never removes a deduplicated profile still supplied by another installed pack or required by a retained configuration, materialization, snapshot, or query execution.
- The core distribution provides at least one complete generic local code profile and may register additional immutable profiles. Plugins provide model-independent semantic sections and regions plus an optional ordered recommendation list containing only core profile identifiers; they cannot declare compatibility, define vector-space behavior, or execute embedding code.
- `EmbeddingLanguageSupport.mode` is `explicit` or `all_text`. `language_ids` is non-empty exactly for `explicit` and empty for `all_text`; `supports_unclassified_text` independently controls text with no registered programming or content-language classification. It never describes or requires detection of a human language used in identifiers, comments, documentation, or queries.
- `EmbeddingProfile.maximum_document_tokens` and `maximum_query_tokens` are positive limits under its exact tokenizer. `dimensions` is positive. `element_type` is `float32`, `float16`, `int8`, or `uint8`; `vector_encoding` closes byte order, quantization metadata, and packing rules. `normalization` is `none` or `l2`; `distance_metric` is `cosine`, `dot_product`, or `euclidean`. The selected `embedding_contract_version` defines the exact normalization validator and tolerance for every element type.
- `EmbeddingProfile.supported_content_classes` is a non-empty subset of `source_code`, `prose`, `configuration`, `markup`, `data`, and `unknown_text`.
- `EmbeddingProfile.supported_query_classes` is a non-empty subset of `natural_text`, `identifier`, `source_code`, and `mixed`. Query classes describe input structure, not human language. The normalized operation schema supplies the class deterministically: concept or intent text is `natural_text`, canonical or textual symbol identity input is `identifier`, an explicit code fragment is `source_code`, and an input intentionally combining classes is `mixed`. Urdira performs no English, Spanish, or other human-language detection.
- `EmbeddingProfile.replacement_embedding_profile_id` is an optional recommended migration target allowed only for a deprecated or retired profile. It never makes the two vector spaces score-compatible.
- Active profile selection belongs to versioned workspace configuration. Changing that selection creates new semantic materializations; profile availability or plugin installation never rewrites or silently changes a retained materialization.
- A fallback policy is resolved into an exact active profile set before indexing and is not stored as an unresolved choice inside a snapshot or materialization. Once selected, a materialization accepts vectors only from its exact `embedding_profile_id`, profile digest, and generator lock. Failure of that profile changes coverage state; it never admits a vector produced under a generic or replacement profile.
- Language-plugin activation and core embedding-profile activation have independent resolved availability. Missing Urdira model-pack assets prevent only the affected core profile from entering a newly published active configuration; they do not invalidate plugin-produced canonical records or structural capabilities. After profile activation, item-specific generation failure is represented by semantic coverage and diagnostics rather than by removing a language plugin.
- `EvidenceAssumptionDefinition.assumption_code` names an assumption used by evidence. `satisfaction_contract` defines the deterministic registry, configuration, source, or model condition under which the query engine may regard it as satisfied; an assumption with no verifiable satisfied state prevents a chain from becoming confirmed.
- `EvidenceExplanationDefinition.explanation_code` defines a stable concise reason for an evidence conclusion and restricts the bases and derivations with which it may be emitted.

For every definition above except `EmbeddingProfile`, `definition_revision`, `schema_version`, `plugin_owner`, lifecycle, deprecation, retirement, replacement, ownership, and permanent identifier-reservation semantics are identical to the corresponding rules for other typed registries. Published meaning is immutable; incompatible meaning requires a new identifier. `EmbeddingProfile` is always core-owned, has no `plugin_owner`, and is stricter: a revision may improve description or guidance only and cannot change any vector-space field covered by `profile_digest`.

Embedding-specific field contracts:

| Model.field | Exact meaning |
|---|---|
| `EmbeddingProfile.embedding_profile_id` | Permanent registered vector-space identifier. |
| `EmbeddingProfile.description` | Concise human-readable profile purpose and boundary; it cannot claim stronger evaluated quality than the profile's published evidence. |
| `EmbeddingProfile.embedding_contract_version` | Positive core behavior contract jointly implemented by document/query rendering, segmentation, generation, and retrieval. |
| `EmbeddingProfile.model_provider_id` | Stable provider or distribution namespace recorded inside the registered profile; it is not an inference endpoint or a separately selectable runtime. |
| `EmbeddingProfile.model_id` | Provider-stable model family identifier. |
| `EmbeddingProfile.model_revision` | Immutable provider revision selected inside that family. |
| `EmbeddingProfile.model_identity_digest` | Recomputed `ModelAssetManifest.model_identity_digest` for the exact provider, model, revision, architecture, format, configuration assets, and ordered weight shards. |
| `EmbeddingProfile.tokenizer_id` | Provider-stable tokenizer family identifier. |
| `EmbeddingProfile.tokenizer_revision` | Immutable tokenizer revision. |
| `EmbeddingProfile.tokenizer_digest` | Recomputed `TokenizerAssetManifest.tokenizer_digest` for the exact tokenizer identity, revision, format, configuration assets, data assets, and positional interpretation rules. |
| `EmbeddingProfile.document_input_contract` | Exact renderer and template used for indexed passage inputs; its purpose is `document`. |
| `EmbeddingProfile.query_input_contract` | Exact renderer and template used for query inputs; its purpose is `query`. |
| `EmbeddingProfile.segmentation_contract` | Exact model-specific segmenter implementation and configuration. |
| `EmbeddingProfile.maximum_document_tokens` | Positive maximum rendered passage tokens accepted by the profile. |
| `EmbeddingProfile.maximum_query_tokens` | Positive maximum rendered query tokens accepted by the profile. |
| `EmbeddingProfile.dimensions` | Positive output vector dimension. |
| `EmbeddingProfile.element_type` | Logical scalar or bit representation stored in canonical vector bytes. |
| `EmbeddingProfile.vector_encoding` | Closed canonical byte layout, including byte order, packing, and any quantization parameters. |
| `EmbeddingProfile.normalization` | Required stored-vector normalization, `none` or `l2`. |
| `EmbeddingProfile.distance_metric` | Sole raw similarity or distance function valid inside this vector space. |
| `EmbeddingProfile.language_support` | Exact explicit-language or all-text declaration for indexed programming or content languages; never a human-language declaration. |
| `EmbeddingProfile.supported_query_classes` | Non-empty supported structural query classes: `natural_text`, `identifier`, `source_code`, and/or `mixed`; no human-language classification is implied. |
| `EmbeddingProfile.supported_content_classes` | Non-empty supported text classes. Binary content is never valid here. |
| `EmbeddingProfile.agent_guidance` | Concise selection and limitation guidance exposed through administrative model-profile introspection; it is not returned by normal agent intelligence queries. |
| `EmbeddingProfile.profile_digest` | Digest of `embedding_profile_id` and every field from `embedding_contract_version` through `supported_content_classes`, including `supported_query_classes`; descriptive and registry-lifecycle metadata are excluded. |
| `EmbeddingInputContract.renderer_id` | Registered executable core component responsible for deterministic rendering and shipped with an exact Urdira engine version. A model pack may reference this identity and provide declarative inputs but cannot supply its implementation. |
| `EmbeddingInputContract.renderer_version` | Exact component version whose definition contains a compatible `embedding_renderer` contract binding. |
| `EmbeddingInputContract.template_digest` | Digest of the complete fixed input template, labels, separators, and escaping rules. |
| `EmbeddingInputContract.input_purpose` | `document` or `query`; it must agree with the containing profile field. |
| `EmbeddingSegmentationContract.segmenter_id` | Registered executable core component responsible for segmentation and shipped with an exact Urdira engine version. A model pack may reference this identity and provide declarative inputs but cannot supply its implementation. |
| `EmbeddingSegmentationContract.segmenter_version` | Exact component version whose definition contains a compatible `embedding_segmenter` contract binding. |
| `EmbeddingSegmentationContract.configuration_digest` | Exact `ModelPackRuntimeConfiguration.configuration_digest` for this profile's `segmenter` role, committing the component binding, closed schema, and every segment-boundary, packing, and overlap setting capable of changing output. |
| `EmbeddingLanguageSupport.mode` | `explicit` or `all_text`. |
| `EmbeddingLanguageSupport.language_ids` | Non-empty registered set exactly for explicit mode; empty for all-text mode. |
| `EmbeddingLanguageSupport.supports_unclassified_text` | Whether text with no registered language classification may be segmented and embedded. |

### Model-pack manifest

```text
ModelPackManifest
  manifest_schema_version
  model_pack_id
  model_pack_version
  embedding_profiles[]
  assets[]
  required_runtime_components[]
  manifest_digest
```

| Model.field | Exact meaning |
|---|---|
| `ModelPackManifest.manifest_schema_version` | Positive core bootstrap-schema version used to decode and validate the complete closed manifest before any asset is opened. Unknown versions are rejected; fields from another version are never ignored. |
| `ModelPackManifest.model_pack_id` | Stable canonical namespaced pack identifier whose uniqueness is enforced within an installation. It conveys no authenticated publisher ownership. |
| `ModelPackManifest.model_pack_version` | Exact normalized SemVer 2.0.0 version permanently bound to one canonical manifest digest. Build metadata is preserved as part of the exact coordinate even though SemVer precedence ignores it. |
| `ModelPackManifest.embedding_profiles` | Non-empty duplicate-free ordered set of complete `EmbeddingProfile` definitions, canonically ordered by `embedding_profile_id`. Each stored `profile_digest` is recomputed before installation may continue. |
| `ModelPackManifest.assets` | Non-empty complete ordered set of `ModelPackAssetEntry` values. Every declared entry is mandatory and canonical ordering follows the asset-entry contract below. |
| `ModelPackManifest.required_runtime_components` | Non-empty complete ordered set of `ModelPackRuntimeRequirement` values needed to render, segment, generate, and infer for every embedded profile. Requirements can only select components already shipped with the target Urdira engine. |
| `ModelPackManifest.manifest_digest` | Digest of exactly the six preceding fields under `core:model_pack_manifest_digest`; the digest field itself and all delivery metadata are omitted. Urdira recomputes it before collision checks or asset acquisition. |

`ModelPackManifest` is closed. Publisher, author, signature, key, certificate, trust, timestamp, description, filename, logical path, URL, mirror, credential, transport header, compression, archive-layout, local-state, and installation-state fields are forbidden. Human guidance belongs to embedded profiles; licenses, provenance, and evaluations are digest-addressed assets with their corresponding semantic roles; delivery locators use a separate non-canonical administrative transport model.

Canonical identity is `model_pack_id + model_pack_version + manifest_digest`. Repeating the exact triple is idempotent. Repeating the first two values with another digest is a hard collision. No field may be patched in place; any change to the six digest-covered fields requires another pack version.

### Model-pack asset entry

```text
ModelPackAssetEntry
  content_digest
  decoded_byte_length
  media_type
  semantic_role
```

| Model.field | Exact meaning |
|---|---|
| `ModelPackAssetEntry.content_digest` | Sole identity of the exact decoded blob bytes in Urdira's local content-addressed store. It uses `core:model_pack_asset_digest`; pack-local IDs, filenames, logical paths, URLs, and archive members are never asset identities. |
| `ModelPackAssetEntry.decoded_byte_length` | Exact non-negative byte length after removal of delivery compression or archive framing and before any model-format parsing. It must equal the locally stored blob length. |
| `ModelPackAssetEntry.media_type` | Canonical lowercase ASCII `type/subtype` describing the decoded bytes. Parameters and content-encoding declarations are forbidden because delivery encoding is outside asset identity. |
| `ModelPackAssetEntry.semantic_role` | Exactly one closed core role describing how the containing pack uses the blob: `model_manifest`, `model_weight`, `model_configuration`, `tokenizer_manifest`, `tokenizer_data`, `input_template`, `segmentation_configuration`, `generator_configuration`, `license`, `provenance`, or `evaluation`. |

The manifest's `assets` collection is non-empty, rejects duplicate `semantic_role + content_digest` pairs, and is canonically ordered first by the closed semantic-role ordinal above and then by canonical digest bytes. Reordering producer input cannot change `manifest_digest`. Multiple entries may reference the same `content_digest` under different roles; they identify one physical blob and Urdira stores its bytes once. All entries sharing a digest must declare the same `decoded_byte_length` and `media_type`.

`model_manifest` and `tokenizer_manifest` assets are deterministic declarative root documents interpreted only by built-in Urdira schemas. They reference subordinate assets directly by `content_digest`; model shard order is explicit and semantic. Every referenced digest must occur in the same pack's `assets` collection, reference graphs must be acyclic, and no reference may resolve through a path, filename, URL, catalog, or another pack. Other roles are terminal blobs unless their built-in media-type schema explicitly defines digest references.

The digest covers the exact decoded blob bytes, not an archive member, compressed representation, download stream, filesystem metadata, or local CAS path. Transport may rename, split into archives, mirror, or compress a blob only when installation reconstructs exactly the declared bytes, length, and digest before publication.

#### Input-template assets

An `input_template` asset is the template itself, not a wrapper manifest. Its decoded bytes are strict UTF-8, its exact media type is `text/plain`, and its `ModelPackAssetEntry.content_digest` covers those bytes under the generic model-pack asset domain. Independently, `EmbeddingInputContract.template_digest` covers the same bytes under `core:embedding_template_digest`. The values are normally different because their digest domains are different; both must verify.

Every embedded profile's document and query input contracts each resolve exactly one same-pack `input_template` entry by recomputing `template_digest` over the entry's bytes. Both contracts may resolve the same entry. Every `input_template` entry must be referenced by at least one embedded profile input contract; an unreferenced template is an invalid orphan. This reachability rule does not apply to license, provenance, evaluation, or other metadata roles whose presence is meaningful directly from the pack manifest.

The template contains only fixed UTF-8 text, renderer-defined labels and separators, placeholders from the selected renderer contract's closed vocabulary, and text governed by that contract's exact escaping rules. Placeholder meaning, required presence, expansion order, and escaping belong to `renderer_id + renderer_version + embedding_contract_version`, not to the asset. Includes, imports, paths, filenames, URLs, environment variables, commands, callbacks, code expressions, network values, locale-dependent expansion, and references to other assets are forbidden.

Installation validates UTF-8, media type, both digests, same-pack uniqueness, closed placeholder vocabulary, and renderer compatibility before profile activation. Rendering receives only the normalized semantic input fields declared by the exact core renderer contract; it cannot read files, environment state, clocks, random values, network state, or plugin code.

### Model asset manifest

```text
ModelAssetManifest
  schema_version
  model_provider_id
  model_id
  model_revision
  architecture_id
  model_format
  configuration_asset_digests[]
  weight_asset_digests[]
  model_identity_digest
```

| Model.field | Exact meaning |
|---|---|
| `ModelAssetManifest.schema_version` | Positive core schema version for this complete closed logical model-manifest shape. Unknown versions or fields are rejected. |
| `ModelAssetManifest.model_provider_id` | Exact provider or distribution identifier and equal to every referencing `EmbeddingProfile.model_provider_id`. It is descriptive identity, not authenticated ownership. |
| `ModelAssetManifest.model_id` | Exact provider-stable model family identifier and equal to every referencing profile's `model_id`. |
| `ModelAssetManifest.model_revision` | Exact immutable provider revision and equal to every referencing profile's `model_revision`. Mutable tags, latest selectors, ranges, and aliases are forbidden. |
| `ModelAssetManifest.architecture_id` | Closed core model-architecture identifier supported by the exact Urdira engine. Model packs and plugins cannot define another value. |
| `ModelAssetManifest.model_format` | Closed core decoded model-storage format supported by the exact Urdira engine. Compression and archive format are delivery concerns and cannot appear here. |
| `ModelAssetManifest.configuration_asset_digests` | Ordered duplicate-free list of same-pack `ModelPackAssetEntry.content_digest` values whose entries have role `model_configuration`. It may be empty when the supported model format requires no external configuration; producer order is semantic and digest-covered. |
| `ModelAssetManifest.weight_asset_digests` | Non-empty ordered duplicate-free list of same-pack asset content digests whose entries have role `model_weight`. List order is the exact shard order consumed by the generator. |
| `ModelAssetManifest.model_identity_digest` | Digest of exactly the eight preceding fields under `core:model_identity_digest`. The field itself is omitted and the value must equal every referencing `EmbeddingProfile.model_identity_digest`. |

`ModelAssetManifest` is encoded as exact Urdira Canonical Encoding bytes with media type `application/vnd.urdira.model-asset-manifest+cbor` and appears through a `ModelPackAssetEntry` whose semantic role is `model_manifest`. Its asset `content_digest` covers the complete encoded bytes including `model_identity_digest`; the logical `model_identity_digest` independently covers the decoded fields except itself. These domains are intentionally distinct.

Every embedded profile resolves exactly one same-pack `ModelAssetManifest` by `model_identity_digest`, and provider, model, and revision fields must also agree. Several profiles may share that exact model manifest. Every configuration and weight digest must resolve inside the same pack with the required role, length, media type, and content digest. Model configuration and weight assets are terminal bytes under this graph; paths, filenames, URLs, cross-pack lookup, implicit shard discovery, and undeclared sidecar files are forbidden.

The selected profile's `generator` runtime requirement must declare support for the exact `architecture_id + model_format` pair through its registered `embedding_generator` contract. Failure of schema decoding, canonical encoding, field equality, asset closure, shard ordering, format support, or either digest rejects the candidate pack atomically. The manifest contains data only and cannot specify loader code, entry points, commands, callbacks, dynamic libraries, or execution flags.

### Tokenizer asset manifest

```text
TokenizerAssetManifest
  schema_version
  tokenizer_id
  tokenizer_revision
  tokenizer_format
  configuration_asset_digests[]
  tokenizer_data_asset_digests[]
  tokenizer_digest
```

| Model.field | Exact meaning |
|---|---|
| `TokenizerAssetManifest.schema_version` | Positive core schema version for this complete closed logical tokenizer-manifest shape. Unknown versions or fields are rejected. |
| `TokenizerAssetManifest.tokenizer_id` | Exact provider-stable tokenizer family identifier and equal to every referencing `EmbeddingProfile.tokenizer_id`. |
| `TokenizerAssetManifest.tokenizer_revision` | Exact immutable tokenizer revision and equal to every referencing profile's `tokenizer_revision`. Mutable tags, latest selectors, ranges, and aliases are forbidden. |
| `TokenizerAssetManifest.tokenizer_format` | Closed core tokenizer format whose exact engine contract defines decoding, normalization, pre-tokenization, positional asset meaning, token production, special-token handling, truncation inputs, and token-count semantics. Packs and plugins cannot define another format. |
| `TokenizerAssetManifest.configuration_asset_digests` | Ordered duplicate-free list of same-pack asset content digests whose entries have role `tokenizer_data`. It may be empty when the tokenizer format has no separate configuration. Producer order is semantic under the selected format. |
| `TokenizerAssetManifest.tokenizer_data_asset_digests` | Non-empty ordered duplicate-free list of same-pack asset content digests whose entries have role `tokenizer_data`. It contains every vocabulary, merge table, tokenizer model, special-token table, normalization data, or other byte input required by the selected format. Producer order is semantic. |
| `TokenizerAssetManifest.tokenizer_digest` | Digest of exactly the six preceding fields under `core:tokenizer_identity_digest`. The field itself is omitted and the value must equal every referencing `EmbeddingProfile.tokenizer_digest`. |

The configuration and tokenizer-data lists are disjoint. A digest cannot occur in both lists, and neither list may contain an undeclared, cross-pack, path-resolved, or role-mismatched asset. `tokenizer_format` defines the exact meaning of every list position, so a reordering changes tokenizer identity even when the same blobs remain present.

`TokenizerAssetManifest` is encoded as exact Urdira Canonical Encoding bytes with media type `application/vnd.urdira.tokenizer-asset-manifest+cbor` and appears through a `ModelPackAssetEntry` whose role is `tokenizer_manifest`. Its asset `content_digest` covers the complete encoded bytes including `tokenizer_digest`; the logical tokenizer digest independently covers the decoded fields except itself. These domains are intentionally distinct.

Every embedded profile resolves exactly one same-pack tokenizer manifest by `tokenizer_digest`, and tokenizer ID and revision must also agree. Several profiles may share it. The profile's `segmenter` and `generator` runtime requirements must both declare support for the exact `tokenizer_format` through their registered contracts. Failure of canonical decoding, field equality, asset closure, list disjointness, positional interpretation, runtime-format support, or either digest rejects installation atomically.

No tokenizer asset may be discovered from a filename, directory convention, URL, environment cache, system vocabulary, implicit sidecar, runtime download, plugin, or another pack. The manifest cannot specify tokenizer code, entry points, imports, commands, callbacks, native libraries, or execution flags.

### Model-pack runtime configuration

```text
ModelPackRuntimeConfiguration
  schema_version
  embedding_profile_id
  runtime_role
  component_id
  component_version
  contract_version
  configuration_schema_id
  configuration
  configuration_digest
```

| Model.field | Exact meaning |
|---|---|
| `ModelPackRuntimeConfiguration.schema_version` | Positive core bootstrap-schema version of this closed envelope. It versions the envelope, not the component-specific configuration value. Unknown versions or fields are rejected. |
| `ModelPackRuntimeConfiguration.embedding_profile_id` | Exact embedded profile whose runtime behavior this value configures. It cannot refer to another pack or to a profile resolved through delivery metadata. |
| `ModelPackRuntimeConfiguration.runtime_role` | Exactly `segmenter` or `generator`. Renderer configuration is represented by the profile's digest-addressed input templates and cannot use this envelope. |
| `ModelPackRuntimeConfiguration.component_id` | Exact core runtime component selected by the matching `ModelPackRuntimeRequirement`. |
| `ModelPackRuntimeConfiguration.component_version` | Exact component release selected by that requirement; ranges, aliases, and platform-selected variants are forbidden. |
| `ModelPackRuntimeConfiguration.contract_version` | Exact component-contract version selected by that requirement and equal to the profile's `embedding_contract_version`. |
| `ModelPackRuntimeConfiguration.configuration_schema_id` | Exact closed canonical schema identifier declared by the selected component's matching `RuntimeComponentContractBinding`. Its exact schema version is pinned by that binding and cannot be chosen by the pack. |
| `ModelPackRuntimeConfiguration.configuration` | Complete typed value validated against that exact schema through Schema IR. It is not opaque JSON or CBOR; unknown fields, untyped values, and schema extensions are rejected. |
| `ModelPackRuntimeConfiguration.configuration_digest` | UCE digest of exactly the preceding eight fields under `core:model_pack_runtime_configuration_digest`. The included `runtime_role` separates segmenter and generator meanings. The digest field itself is omitted. |

The complete envelope is encoded as exact Urdira Canonical Encoding bytes with media type `application/vnd.urdira.model-pack-runtime-configuration+cbor`. A `segmenter` value appears through exactly one same-pack `ModelPackAssetEntry` with semantic role `segmentation_configuration`; a `generator` value appears through exactly one entry with role `generator_configuration`. Its asset `content_digest` covers the complete encoded bytes including `configuration_digest`, while the logical configuration digest independently covers the decoded envelope except its own field.

Every embedded profile resolves exactly one runtime-configuration asset for each of the two roles. Logical uniqueness is `embedding_profile_id + runtime_role`. The envelope's component ID, component version, and contract version must equal the matching `ModelPackRuntimeRequirement`; the selected runtime definition must expose the corresponding `embedding_segmenter` or `embedding_generator` binding, and the envelope's `configuration_schema_id` must equal the schema ID in that binding. The binding's exact schema version validates `configuration` before either digest is accepted.

For `segmenter`, the recomputed `configuration_digest` must equal `EmbeddingProfile.segmentation_contract.configuration_digest`. For `generator`, it is the sole generator configuration digest permitted for new semantic materializations and query embeddings using that installed profile. `SemanticIndexMaterialization`, `QueryEmbedding`, and `SemanticIndexBinding` copy that exact digest, and their generator ID and version equal the configuration envelope and runtime requirement. Retained materializations and query executions keep their pinned digest even after another pack version is installed.

The two configurations are part of the portable binding of the profile. Two packs may deduplicate one `embedding_profile_id` only when both complete canonical envelopes, including their recomputed configuration digests, are identical in addition to the profile definition and four runtime requirements. A generator-configuration difference under the same profile ID is a hard activation collision even though generator configuration is intentionally absent from `EmbeddingProfile.profile_digest`.

The configuration schema may express only deterministic, portable values consumed by the exact component contract. Environment variables, filesystem paths, URLs, commands, callbacks, arbitrary implementation flags, mutable external references, locale defaults, hardware probing, and platform-dependent or `auto` values are forbidden. Every output-affecting choice must be explicit, schema-typed, and identically interpreted by every runtime build advertising the exact behavior digest and contract.

An absent, duplicate, orphaned, role-mismatched, schema-mismatched, non-canonical, or digest-mismatched configuration rejects installation atomically. Model packs cannot register configuration schemas: every selected schema is already part of the exact core engine registry.

### Model-pack runtime requirement

```text
ModelPackRuntimeRequirement
  embedding_profile_id
  runtime_role
  component_id
  component_version
  behavior_digest
  contract_version

ResolvedModelPackRuntimeBuild
  embedding_profile_id
  runtime_role
  component_id
  component_version
  behavior_digest
  contract_version
  runtime_component_build_id
  implementation_digest
```

| Model.field | Exact meaning |
|---|---|
| `ModelPackRuntimeRequirement.embedding_profile_id` | Exact embedded `EmbeddingProfile.embedding_profile_id` to which this requirement applies. Cross-pack, absent, retired-only, or delivery-resolved profile references are invalid. |
| `ModelPackRuntimeRequirement.runtime_role` | Exactly one closed role: `document_renderer`, `query_renderer`, `segmenter`, or `generator`. The role determines the required runtime-component contract and has no extension namespace. |
| `ModelPackRuntimeRequirement.component_id` | Exact platform-neutral core `RuntimeComponentDefinition.component_id` implemented by compatible Urdira builds. Model-pack or plugin component identities are invalid. |
| `ModelPackRuntimeRequirement.component_version` | Exact platform-neutral behavior release; ranges, latest-version selectors, platform aliases, and fallback lists are forbidden. |
| `ModelPackRuntimeRequirement.behavior_digest` | Exact platform-neutral `RuntimeComponentDefinition.behavior_digest`. It pins behavior and contracts without naming an operating-system or architecture-specific executable build. |
| `ModelPackRuntimeRequirement.contract_version` | Exact positive component-contract version required by the profile. It must equal `EmbeddingProfile.embedding_contract_version`. |

Every embedded profile has exactly four requirements, one for each role. Logical uniqueness is `embedding_profile_id + runtime_role`; duplicate roles, missing roles, alternatives, preference order, optional requirements, and fallback components are invalid. The manifest collection is canonically ordered by `embedding_profile_id`, then the role ordinal `document_renderer`, `query_renderer`, `segmenter`, `generator`. The remaining fields cannot affect ordering because the logical key is unique.

`document_renderer` requires the `embedding_renderer` component contract and its component ID and version must equal `EmbeddingProfile.document_input_contract.renderer_id + renderer_version`. `query_renderer` has the same contract and must equal the query input contract coordinates. `segmenter` requires `embedding_segmenter` and must equal `EmbeddingProfile.segmentation_contract.segmenter_id + segmenter_version`. `generator` requires `embedding_generator`; it owns declarative model loading and inference through engine code and is the only generator permitted for new materializations of that profile under the pack.

For all four roles, the resolved platform-neutral definition must contain the corresponding contract binding at `contract_version`, that version must equal the profile's `embedding_contract_version`, and its behavior digest must match. Failure of any reference, role, binding, version, or behavior digest rejects pack installation atomically. One core component may satisfy several roles only when its registered definition exposes every required contract, and may be reused by any number of profiles through separate requirement entries.

The four-entry requirement set and the two runtime-configuration envelopes are the portable behavior binding of an `embedding_profile_id`, even though they remain manifest assets or fields rather than fields of `EmbeddingProfile.profile_digest`. Two packs can share and deduplicate a portable profile only when this complete binding is byte-for-byte equal after canonicalization. A differing component, version, behavior digest, role, contract version, or runtime configuration under the same profile ID is a collision. Platform-specific build differences are resolved later and do not change pack identity.

`ResolvedModelPackRuntimeBuild` fields:

| Model.field | Exact meaning |
|---|---|
| `ResolvedModelPackRuntimeBuild.embedding_profile_id` | Exact portable profile being activated locally. |
| `ResolvedModelPackRuntimeBuild.runtime_role` | One of the four closed model-pack runtime roles. |
| `ResolvedModelPackRuntimeBuild.component_id` | Exact component ID copied from the portable requirement. |
| `ResolvedModelPackRuntimeBuild.component_version` | Exact behavior release copied from the portable requirement. |
| `ResolvedModelPackRuntimeBuild.behavior_digest` | Exact platform-neutral behavior digest copied from the requirement and selected definition. |
| `ResolvedModelPackRuntimeBuild.contract_version` | Exact contract version copied from the requirement. |
| `ResolvedModelPackRuntimeBuild.runtime_component_build_id` | Exact locally installed Urdira build selected for this role. It never appears in the model-pack manifest. |
| `ResolvedModelPackRuntimeBuild.implementation_digest` | Exact executable build digest recomputed from the selected `RuntimeComponentBuild`. |

Every locally activated profile resolves exactly four build values in the same role order as its requirements. Each selected build must be currently selectable, implement the exact component ID, behavior release, and behavior digest, and expose the required contract. Selection occurs only while creating a new executable binding. Later engine or platform changes never rewrite an existing binding.

Runtime configuration is not duplicated in this model. Renderer templates remain profile-referenced assets, while segmenter and generator values use exactly one role-specific `ModelPackRuntimeConfiguration` asset per profile. Model and tokenizer identity remain in their dedicated manifests. No requirement permits pack-provided code, dynamic component discovery, or query-time selection.

### Installed model-pack and executable-profile lifecycle

Canonical pack content, local installation occurrences, permanent coordinate ownership, and deduplicated executable profile meaning are separate models:

Profiles bundled with the Urdira distribution use the same data-only manifest, installation, binding, supply, verification, and retention path as separately installed packs. Their delivery is local and automatic as part of the explicit Urdira installation or upgrade, but their canonical model receives no privileged alternate shape.

```text
ModelPackCoordinateReservation
  schema_version
  model_pack_id
  model_pack_version
  manifest_digest
  first_registered_at

ModelPackInstallation
  model_pack_installation_id
  schema_version
  model_pack_id
  model_pack_version
  manifest_digest
  installed_at
  removed_at?
  removal_reason_code?

EmbeddingProfileExecutableBinding
  schema_version
  embedding_profile_id
  embedding_profile_digest
  runtime_requirements[]
  runtime_configurations[]
  operational_asset_digests[]
  portable_binding_digest
  resolved_runtime_builds[]
  executable_binding_digest

ModelPackProfileSupply
  model_pack_profile_supply_id
  schema_version
  model_pack_installation_id
  embedding_profile_id
  portable_binding_digest
  supplied_at
  released_at?
  release_reason_code?
```

`ModelPackCoordinateReservation` fields:

| Model.field | Exact meaning |
|---|---|
| `ModelPackCoordinateReservation.schema_version` | Positive version of this closed installation-registry schema. |
| `ModelPackCoordinateReservation.model_pack_id` | Permanently reserved pack identifier. |
| `ModelPackCoordinateReservation.model_pack_version` | Exact normalized SemVer permanently paired with one manifest digest. |
| `ModelPackCoordinateReservation.manifest_digest` | Sole canonical manifest digest ever accepted for this pack ID and version. |
| `ModelPackCoordinateReservation.first_registered_at` | Informational time the exact coordinate was first published locally. |

The compound identity is `model_pack_id + model_pack_version`. A reservation is permanent minimal collision metadata and never roots the manifest or any asset. Reinstalling the exact manifest is allowed; presenting another digest under reserved coordinates is always a hard collision, including after every installation occurrence has been removed.

`ModelPackInstallation` fields:

| Model.field | Exact meaning |
|---|---|
| `ModelPackInstallation.model_pack_installation_id` | Immutable identity of one uninterrupted locally installed occurrence. |
| `ModelPackInstallation.schema_version` | Positive version of this closed installation-occurrence schema. |
| `ModelPackInstallation.model_pack_id` | Exact reserved pack identifier. |
| `ModelPackInstallation.model_pack_version` | Exact reserved pack version. |
| `ModelPackInstallation.manifest_digest` | Exact verified canonical manifest selected by the reservation. |
| `ModelPackInstallation.installed_at` | Time atomic publication made this occurrence installed and selectable. |
| `ModelPackInstallation.removed_at` | One-way removal time; omitted while the occurrence remains installed. |
| `ModelPackInstallation.removal_reason_code` | Registered administrative reason, present exactly with `removed_at`. |

At most one unreleased installation occurrence exists for an exact pack triple. Repeating installation while it is present is idempotent and returns that occurrence. Installing the same triple after removal creates a new occurrence rather than reopening the old one. The record contains no delivery locator, temporary path, credential, mutable progress, or asset copy.

`EmbeddingProfileExecutableBinding` fields:

| Model.field | Exact meaning |
|---|---|
| `EmbeddingProfileExecutableBinding.schema_version` | Positive version of this closed derived registry schema. |
| `EmbeddingProfileExecutableBinding.embedding_profile_id` | Permanent profile identifier whose executable meaning this record closes. |
| `EmbeddingProfileExecutableBinding.embedding_profile_digest` | Recomputed digest of the complete canonical `EmbeddingProfile`. |
| `EmbeddingProfileExecutableBinding.runtime_requirements` | Exactly four canonical `ModelPackRuntimeRequirement` values for this profile, ordered by the fixed role ordinal. |
| `EmbeddingProfileExecutableBinding.runtime_configurations` | Exactly two complete canonical `ModelPackRuntimeConfiguration` values for this profile, ordered `segmenter`, then `generator`. |
| `EmbeddingProfileExecutableBinding.operational_asset_digests` | Non-empty duplicate-free digest-ordered closure of every same-pack blob required to render, segment, generate, or query this profile. License, provenance, and evaluation-only blobs are excluded. |
| `EmbeddingProfileExecutableBinding.portable_binding_digest` | Digest of the six preceding portable fields under `core:embedding_profile_portable_binding_digest`. It is identical across compatible operating systems and architectures. |
| `EmbeddingProfileExecutableBinding.resolved_runtime_builds` | Exactly four `ResolvedModelPackRuntimeBuild` values selected locally in fixed runtime-role order. |
| `EmbeddingProfileExecutableBinding.executable_binding_digest` | Digest of `schema_version + portable_binding_digest + resolved_runtime_builds` under `core:embedding_profile_executable_binding_digest`. It identifies one exact locally executable realization. |

The binding is derived and verified locally, never supplied as another pack asset. One `embedding_profile_id` may have only one portable binding meaning for the lifetime of the local registry; any difference in profile definition, requirement, runtime configuration, or operational asset closure is a collision. Several executable binding digests may realize that same portable meaning across engine upgrades or platforms because their resolved builds differ. Exact executable bindings deduplicate locally. Retained records preserve both portable meaning and exact execution provenance but do not by themselves retain blob or executable bytes.

`operational_asset_digests` includes the model and tokenizer manifests and their complete subordinate closures, both input templates, both runtime-configuration assets, and every model or tokenizer byte required by the exact formats. Its order is canonical digest order and carries no load order; format-specific lists inside the model and tokenizer manifests retain positional semantics.

`ModelPackProfileSupply` fields:

| Model.field | Exact meaning |
|---|---|
| `ModelPackProfileSupply.model_pack_profile_supply_id` | Immutable identity of one uninterrupted installation-to-profile supply occurrence. |
| `ModelPackProfileSupply.schema_version` | Positive version of this closed supply schema. |
| `ModelPackProfileSupply.model_pack_installation_id` | Exact active installation occurrence supplying the profile. |
| `ModelPackProfileSupply.embedding_profile_id` | Exact embedded profile supplied by that installation. |
| `ModelPackProfileSupply.portable_binding_digest` | Exact portable binding derived from the installation's manifest and assets. A supply does not select a platform-specific build. |
| `ModelPackProfileSupply.supplied_at` | Time the supply became visible in the same publication transaction as installation. |
| `ModelPackProfileSupply.released_at` | One-way time this installation stopped supplying the binding; present exactly after installation removal. |
| `ModelPackProfileSupply.release_reason_code` | Registered reason, present exactly with `released_at`. |

Each installation has exactly one supply occurrence per embedded profile, published atomically with the installation and released atomically with its removal. A portable binding is eligible for a new workspace configuration only while at least one active supply exists and all four compatible local builds can be resolved. The new configuration pins the resulting `executable_binding_digest`. If the last supply ends, already pinned work may retain and use its exact binding, operational assets, and runtime builds, but new configurations cannot select it. Reinstalling a supplying pack creates new installation and supply occurrences without changing portable meaning.

An active installation is a storage root for its complete manifest asset set, including metadata-only assets. A pinned executable binding roots `operational_asset_digests` and the exact four `RuntimeComponentBuild` implementation closures. Removing an installation therefore releases metadata blobs to ordinary reachability collection while preserving operational blobs and builds still needed by active or retained work. Physical deletion occurs only through the global mark-and-sweep barrier; reference counts and wall-clock age never authorize deletion independently.

Installation, repair, activation, and removal use staged operational attempts outside these canonical registry models. Pack installation publishes the coordinate reservation, installation occurrence, portable binding meaning, supplies, and asset roots after content validation; it does not require or record a platform build inside the pack. Workspace activation separately publishes an exact executable binding only after resolving all four local builds. Failure or cancellation publishes no partial state. Repair may restore exact missing bytes or build closures but cannot alter a manifest, portable binding, supply, or retained executable binding. Corruption makes affected profiles explicitly unavailable and never triggers fallback or silent replacement.

## Namespaced plugin extensions

### Identifier and ownership rules

Every extensible registry identifier uses the exact form `<namespace>:<local_name>`. Both components contain only lowercase ASCII letters, digits, and underscores, and each begins with a letter. Comparison is exact: Urdira performs no case folding, alias expansion, or Unicode normalization.

`core` is permanently reserved to Urdira. Every logical plugin has one globally unique immutable `plugin_id` and exactly one canonical immutable namespace. An installable package may contain several logical plugins when it needs several namespaces. Changing a namespace or transferring it to another `plugin_id` creates a different ownership identity and requires an explicit migration or reindex.

One namespace has at most one owner in an index. Installation may retain packages that claim the same namespace and must warn about the collision, but activation rejects competing owners for the same index. A retained index association also blocks a different owner from silently reinterpreting the namespace after the previous plugin is disabled.

Identifier ownership is scoped to the typed registry. Canonical schemas, digest recipes, digest references, digest domains, canonical comparators, external verification contracts, runtime components, record kinds, facets, semantic roles, metrics, effects, diagnostic codes, candidate issue codes, dependency roles, projection kinds, lifecycle reasons, completeness reasons, semantic section kinds, semantic reasons, embedding profiles, evidence assumptions, and evidence explanations are distinct registries and may use the same namespaced spelling without aliasing one another. Hash algorithms, canonical-encoding errors, and operation-error codes form separate core-only registries. Therefore the same spelling may legally identify, for example, one completeness reason and one operation error without creating an alias or ownership collision.

One identifier in one typed registry names one permanent definition lineage with one immutable semantic owner. Versioned occurrences within that lineage are not identifier collisions:

| Registry | Immutable occurrence key |
|---|---|
| Canonical schema | `schema_id + schema_version + definition_revision` |
| Digest recipe | `digest_recipe_id + recipe_version + definition_revision` |
| Canonical comparator | `comparator_id + comparator_version + definition_revision` |
| External verification contract | `external_verification_contract_id + contract_version + definition_revision` |
| Runtime component | `component_id + component_version + definition_revision` |
| Every other definition registry | `identifier + definition_revision` |

`definition_revision` is strictly increasing and unique across the complete lineage, so a revision alone selects at most one occurrence for an identifier. A registry snapshot may retain several structural, recipe, comparator, verifier, or runtime-component versions under the same lineage identifier, but it selects at most one definition revision for each exact semantic version. Publishing the same identifier under another owner or with incompatible stable meaning is a collision even when a new numeric version is supplied. Digest domains additionally have immutable semantic ownership and cannot be rebound across recipe versions. A runtime-component ID/version pair additionally has one immutable platform-neutral behavior digest; each runtime-build ID has one immutable implementation digest. Hash algorithm meaning is immutable under its algorithm name.

Except for byte-identical shared `LanguageDefinition` supplies, the `plugin_owner` field on every plugin-owned definition is the owning `plugin_id`, not its namespace. A plugin-owned identifier must begin with the namespace bound to that owner. Core definitions and shared language definitions omit `plugin_owner`.

### Closed universal taxonomy and extension mappings

Only Urdira may define universal kinds. Every plugin-owned `RecordKindDefinition` maps to exactly one existing `core:*` universal kind in the same category. Plugins cannot register a universal kind or redefine a core definition.

The remaining registries use only sound implications:

- A plugin facet may imply registered core or dependency facets through `implied_facets`; all implied facets are included in the record's complete facet set.
- A plugin semantic role may imply zero or more registered roles through `implied_roles`.
- A plugin effect may imply zero or more registered effects through `implied_effects`.
- A concept with no truthful universal equivalent remains plugin-specific; Urdira never forces a false mapping.
- A producer reuses an existing metric identifier only when algorithm, unit, value type, subject scope, and aggregation semantics are identical. Otherwise it registers a distinct metric.
- Plugin diagnostic codes remain distinct and participate in universal behavior through the required severity, category, scope, completeness, recovery, guidance, and payload fields of `DiagnosticCodeDefinition`.

Implication graphs are acyclic. The canonical fact stores only its most precise declared semantic value. Core and plugin implication matches are derived from the snapshot-pinned registry, may be indexed as rebuildable projections, and retain the original fact's evidence and lifecycle. Agent-visible matches distinguish the declared value from the value through which it matched.

### Relation specialization

A concrete plugin relation is a monotonic specialization of its universal relation:

- It retains every universal role under the same role name.
- It may narrow allowed target types, require additional target facets, increase minimum cardinality, or reduce maximum cardinality.
- It cannot remove a universal role, widen its target set, or relax its cardinality.
- It retains the universal anchor and every universal identity role.
- It may add identity components when required to distinguish concrete relations.
- Additional roles use full identifiers in the plugin namespace, such as `nestjs:http_method`.

Projecting a concrete relation through its universal kind preserves additional arguments as plugin context without changing the universal role semantics.

### Additive cross-plugin enrichment

A plugin may reference records and definitions owned by a declared dependency, but it cannot mutate or re-register them. Cross-plugin analysis emits independently owned relations or facts targeting the foreign records. For example, a framework plugin represents a framework role discovered on a language entity as an evidenced fact rather than modifying the language plugin's entity facets.

This rule gives every contribution independent evidence, invalidation, version, and producer ownership. Inline facets remain intrinsic properties emitted by the producer that owns the record.

### Plugin output and query-policy boundary

Plugin contracts end at validated source acquisition, analysis, resolution, enrichment, model-independent semantic preparation, derived projection, diagnostics, coverage, capability, provenance, and registry-definition output. Plugins do not define embedding profiles or components, query operations, intent recipes, selection semantics, graph traversal, ranking profiles, ranking features, weights, fusion, ordering, pagination, cursor behavior, or public result schemas. Those are core contracts and are absent from `PluginRegistryContribution`.

The core may query and rank plugin-produced records through their canonical fields, universal kinds, facets, relations, evidence, capabilities, completeness, and registered semantic definitions. It never invokes plugin code or consumes a plugin-private score to decide result membership or order. A new plugin can therefore add knowledge without changing the meaning of an existing query operation.

### Atomic registration models

Plugin definitions are closed and registered atomically before the plugin may index a workspace. Runtime analysis cannot invent any canonical schema, digest domain, canonical comparator, external verification contract, permitted runtime component, digest recipe, digest reference, language, capability contract, construct class, capability limitation, kind, facet, semantic role, metric, effect, diagnostic code, candidate issue code, dependency role, projection kind, lifecycle reason, completeness reason, semantic section kind, semantic reason, evidence assumption, or evidence explanation from repository content. Embedding profiles and embedding runtime components are core registry values and cannot be contributed or emitted by plugins.

```text
PluginRegistryContribution
  plugin_id
  plugin_version
  namespace
  registry_contract_version
  dependencies[]
  canonical_schema_definitions[]
  digest_domain_definitions[]
  canonical_comparator_definitions[]
  external_verification_contract_definitions[]
  runtime_component_definitions[]
  digest_recipe_definitions[]
  digest_reference_definitions[]
  language_definitions[]
  capability_contract_definitions[]
  construct_class_definitions[]
  capability_limitation_definitions[]
  record_kind_definitions[]
  facet_definitions[]
  semantic_role_definitions[]
  metric_definitions[]
  effect_definitions[]
  diagnostic_code_definitions[]
  candidate_issue_code_definitions[]
  dependency_role_definitions[]
  projection_kind_definitions[]
  lifecycle_reason_code_definitions[]
  completeness_reason_definitions[]
  semantic_section_kind_definitions[]
  semantic_reason_definitions[]
  evidence_assumption_definitions[]
  evidence_explanation_definitions[]
  contribution_digest

PluginDependencyRequirement
  plugin_id
  namespace
  version_requirement
  required_capabilities[]

NamespaceBinding
  namespace_binding_id
  workspace_id
  namespace
  plugin_id
  plugin_version
  contribution_digest
  emission_valid_from_generation
  emission_valid_to_generation?

RegistryNamespaceBindingEntry
  namespace_binding_id
  workspace_id
  namespace
  plugin_id
  plugin_version
  contribution_digest
  emission_valid_from_generation
  emission_valid_to_generation?

RegistrySnapshot
  registry_snapshot_id
  registry_contract_version
  core_registry_digest
  resolution_lock_id
  namespace_bindings[]
  registry_digest
```

`PluginRegistryContribution` fields:

- `plugin_id` is the globally unique immutable logical-plugin identifier that owns every non-core definition in the contribution.
- `plugin_version` is the exact plugin release publishing the contribution.
- `namespace` is the plugin's one canonical namespace and must prefix every contributed definition identifier.
- `registry_contract_version` is the exact Urdira registry contract against which the contribution requests validation.
- `dependencies` is the deduplicated set of mandatory `PluginDependencyRequirement` values. Empty means the contribution depends only on core.
- `canonical_schema_definitions` is the complete closed set of plugin-owned immutable Schema IR definitions used by this contribution. Every schema identifier uses the plugin namespace.
- `digest_domain_definitions` is the complete closed set of plugin-owned semantic digest spaces. Domain identifiers use the plugin namespace and cannot be rebound by a later recipe version.
- `canonical_comparator_definitions` is the complete closed set of plugin-owned structural comparators referenced by its schemas. Comparator keys use only the portable declarative modes defined above.
- `external_verification_contract_definitions` is the complete closed set of plugin-owned external verifier contracts referenced by its digest references. Their implementations must be supplied by a negotiated runtime contract.
- `runtime_component_definitions` is the complete closed set of plugin-owned platform-neutral source-provider and projection-generator behaviors supplied by this release. Every definition pins its exact behavior digest and independently versioned core component-kind contracts. Executable builds remain package-local implementation records, and embedding component kinds are rejected in a plugin contribution.
- `digest_recipe_definitions` is the complete closed set of plugin-owned digest recipes. Every domain, comparator, target schema, payload schema, verifier, and referenced recipe is available from this contribution, core, or a mandatory declared dependency.
- `digest_reference_definitions` is the complete closed set of plugin-owned copied-digest validation contracts. Every chain terminates at an available computation recipe.
- `language_definitions` is the complete set of shared language definitions supplied by this release. They are not namespace-owned and deduplicate only under the byte-identical shared-supply rule.
- `capability_contract_definitions` is the complete set of namespaced plugin-owned capability contracts introduced by this release. Core capability contracts are referenced, never copied into this set.
- `construct_class_definitions` and `capability_limitation_definitions` are the complete namespaced sets introduced by this release. References to core or dependency-owned definitions remain references rather than duplicate contributions.
- `record_kind_definitions` is the complete closed set of plugin-owned concrete kind definitions published by this plugin version.
- `facet_definitions` is the complete closed set of plugin-owned facet definitions published by this plugin version.
- `semantic_role_definitions` is the complete closed set of plugin-owned semantic-role definitions published by this plugin version.
- `metric_definitions` is the complete closed set of plugin-owned metric definitions published by this plugin version.
- `effect_definitions` is the complete closed set of plugin-owned effect definitions published by this plugin version.
- `diagnostic_code_definitions` is the complete closed set of plugin-owned diagnostic-code definitions published by this plugin version.
- `candidate_issue_code_definitions` is the complete closed set of plugin-owned candidate-execution issue definitions published by this plugin version.
- `dependency_role_definitions` is the complete closed set of plugin-owned reverse-invalidation role definitions published by this plugin version.
- `projection_kind_definitions` is the complete closed set of plugin-owned derived-projection schemas and generator contracts published by this plugin version.
- `lifecycle_reason_code_definitions` is the complete closed set of plugin-owned lifecycle reason definitions published by this plugin version.
- `completeness_reason_definitions` is the complete closed set of plugin-owned coverage reason definitions published by this plugin version.
- `semantic_section_kind_definitions` is the complete closed set of plugin-owned semantic-document section meanings published by this plugin version.
- `semantic_reason_definitions` is the complete closed set of plugin-owned eligibility and semantic-coverage reasons published by this plugin version.
- `evidence_assumption_definitions` is the complete closed set of plugin-owned evidence assumption definitions published by this plugin version.
- `evidence_explanation_definitions` is the complete closed set of plugin-owned evidence explanation definitions published by this plugin version.
- `contribution_digest` is the deterministic digest of the complete contribution, including dependencies, canonical schemas, digest recipes, and every other definition. It is governed by the registered contribution recipe and never serves as the plugin's lifecycle identity.

`PluginDependencyRequirement` fields:

- `plugin_id` is the exact immutable owner required by the dependent contribution.
- `namespace` is the exact namespace that the required owner must bind.
- `version_requirement` is the required canonical `VersionRequirement` over SemVer 2.0.0 plugin versions.
- `required_capabilities` is the deduplicated set of versioned `CapabilityRequirement` values that the resolved dependency must provide. Empty means plugin identity and version are the only dependency constraints.

Every foreign definition reference must target `core`, the contribution's own namespace, or a mandatory declared dependency. Missing or incompatible dependencies reject activation. Optional integrations are separate bridge plugins rather than conditional definition subsets inside one contribution.

`NamespaceBinding` fields:

- `namespace_binding_id` identifies one uninterrupted emission lifecycle; a closed binding is never reopened.
- `workspace_id` identifies the workspace generation sequence governing its interval.
- `namespace` is the exact namespace assigned within the index.
- `plugin_id` is its sole owner for the binding interval.
- `plugin_version` is the exact active producer version.
- `contribution_digest` identifies the exact validated definition set supplied by that version.
- `emission_valid_from_generation` is the first workspace generation in which the binding may produce canonical records.
- `emission_valid_to_generation` is the first generation in which the binding may no longer produce records and is omitted while emission remains active.

Binding intervals are half-open. Closing a binding is monotonic. Reactivating the same plugin version creates a new `namespace_binding_id`. A closed binding may remain in later registry snapshots solely to interpret retained records; retention does not authorize new emission. Namespace ownership collisions are rejected before activation.

`RegistryNamespaceBindingEntry` copies every field of the selected `NamespaceBinding` exactly as observed when its `RegistrySnapshot` is published. The entry is immutable even if the operational binding later receives `emission_valid_to_generation`; a later registry snapshot captures that closed value in another entry copy. Entries are unique by `namespace_binding_id` inside a registry snapshot. Their `contribution_digest` uses the same authoritative model-reference contract as `NamespaceBinding.contribution_digest`.

`RegistrySnapshot` fields:

- `registry_snapshot_id` is the immutable identifier of one fully validated registry state.
- `registry_contract_version` is the exact core contract of the assembled registry snapshot. Contributions negotiated under older supported contracts are normalized into this representation only through lossless core adapters; each original contribution contract remains pinned in `ResolvedPlugin`.
- `core_registry_digest` content-addresses the complete immutable core registry manifest compatible with `registry_contract_version`, including canonical schemas, hash algorithms, digest domains, comparators, verifier contracts, runtime components, recipes, references, and every core semantic or error definition. The contract version constrains compatibility but never ambiguously selects among distinct retained manifest revisions; the claimed digest is independently recomputed before acceptance.
- `resolution_lock_id` identifies the immutable exact plugin resolution under which this registry was validated and activated.
- `namespace_bindings` is the complete deduplicated set of immutable `RegistryNamespaceBindingEntry` copies required to interpret the workspace snapshot, including retained inactive definitions still referenced by records.
- `registry_digest` is the deterministic UCE digest of the complete validated registry state under `core:registry_snapshot_digest`; it commits to `core_registry_digest` and every namespace binding's full `contribution_digest`.

## Schema compatibility and plugin-version negotiation

### Canonical version requirements

Plugin package versions and capability-contract versions use SemVer 2.0.0. SemVer does not define range syntax, so Urdira stores requirements as typed intervals rather than adopting an ecosystem-specific string grammar.

```text
VersionRequirement
  alternatives[]
  allow_prerelease

VersionInterval
  minimum?
  minimum_inclusive?
  maximum?
  maximum_inclusive?

CapabilityRequirement
  capability
  version_requirement
```

`VersionRequirement` fields:

- `alternatives` is a non-empty deduplicated set of `VersionInterval` values interpreted with logical OR. A version satisfies the requirement when it belongs to at least one interval.
- `allow_prerelease` is a required boolean. When false, prerelease versions are excluded even when their precedence lies inside an interval. When true, prereleases are evaluated by ordinary SemVer precedence.

`VersionInterval` fields:

- `minimum` is the optional normalized SemVer lower bound. Omission means the interval has no lower bound.
- `minimum_inclusive` is required exactly when `minimum` is present and states whether the lower bound belongs to the interval; it is omitted otherwise.
- `maximum` is the optional normalized SemVer upper bound. Omission means the interval has no upper bound.
- `maximum_inclusive` is required exactly when `maximum` is present and states whether the upper bound belongs to the interval; it is omitted otherwise.

An interval with both bounds omitted represents every stable version unless `allow_prerelease` also admits prereleases. Equal inclusive bounds represent an exact precedence version. An empty or inverted interval is invalid. Build metadata is preserved in exact resolved versions but ignored for SemVer precedence.

`CapabilityRequirement` fields:

- `capability` is the stable namespaced capability identifier required from the dependency.
- `version_requirement` is the accepted `VersionRequirement` over that capability's semantic contract versions.

Capability contract versions define minimum behavioral guarantees. Precision or derivation method and effective workspace coverage are separate dimensions and do not form one ordered compatibility level. A provider either satisfies the requested capability contract or does not; partial coverage after activation is reported through completeness.

### Compatibility declaration and exact resolution lock

```text
PluginCompatibilityDeclaration
  declaration_schema_version
  plugin_id
  plugin_version
  namespace
  supported_plugin_contract_versions[]
  supported_registry_contract_versions[]
  dependencies[]
  offered_capabilities[]
  recommended_embedding_profile_ids[]
  package_digest
  analysis_digest
  declaration_digest

PluginResolutionLock
  resolution_lock_id
  workspace_id
  resolver_version
  resolved_plugins[]
  lock_digest
  created_at

ResolvedPlugin
  plugin_id
  plugin_version
  namespace
  package_digest
  declaration_digest
  contribution_digest
  analysis_digest
  analysis_configuration_digest
  plugin_contract_version
  registry_contract_version
  resolved_dependency_plugin_ids[]
  effective_capabilities[]
```

`PluginCompatibilityDeclaration` fields:

- `declaration_schema_version` is the positive integer bootstrap schema used to parse this declaration before plugin execution or contract negotiation.
- `plugin_id` is the globally unique immutable logical-plugin identifier.
- `plugin_version` is the exact normalized SemVer release, including preserved prerelease and build metadata.
- `namespace` is the plugin's one canonical immutable namespace.
- `supported_plugin_contract_versions` is the non-empty deduplicated set of positive integer runtime-contract versions the plugin can execute.
- `supported_registry_contract_versions` is the non-empty deduplicated set of positive integer registry contracts for which the plugin can serialize a complete contribution.
- `dependencies` is the complete deduplicated set of mandatory `PluginDependencyRequirement` values used during resolution.
- `offered_capabilities` is the complete set of `PluginCapabilityDeclaration` values the package can negotiate before workspace-specific coverage is assessed.
- `recommended_embedding_profile_ids` is an optional-by-empty, duplicate-free ordered list of core-owned `EmbeddingProfile.embedding_profile_id` preferences. Earlier entries have higher preference when several listed profiles cover the same semantic scope. The field declares no compatibility, requirement, ownership, installation dependency, or direct activation authority. Unknown, uninstalled, policy-forbidden, or incompatible entries are skipped without rejecting or disabling the plugin. An installed usable recommendation may be selected into the newly resolved workspace configuration even when it was not active in the preceding configuration. Profile-owned language, content-class, and query-class contracts remain the sole compatibility source.
- `package_digest` identifies the complete installed package content selected by the package-integrity contract and is computed by `core:plugin_package_digest`.
- `analysis_digest` identifies every packaged executable component, parser, rule set, analyzer-specific non-embedding model, and analysis dependency capable of changing canonical output. It excludes every core-owned embedding profile, model, tokenizer, and runtime. Urdira derives and verifies it from declared package components.
- `declaration_digest` identifies the complete compatibility declaration under `core:plugin_compatibility_declaration_digest`.

The default configuration resolver evaluates recommendations only while constructing a new versioned workspace configuration. For each semantic scope supplied by a plugin, it selects the first available, policy-allowed recommended profile whose own contract is compatible. If none qualifies, it selects Urdira's generic core profile when that profile is compatible. Recommendations from different plugins are resolved independently and the resulting profile set is deduplicated, so several profiles may be activated. Explicit workspace policy may replace this default. The exact selected set is published and pinned before indexing; later installation, removal, failure, or recommendation changes never alter an existing configuration, materialization, snapshot, or query execution.

`PluginResolutionLock` fields:

- `resolution_lock_id` is the immutable identifier of one exact dependency and contract resolution.
- `workspace_id` is the workspace whose installed packages, configuration, and capability environment were resolved.
- `resolver_version` is the positive integer version of Urdira's deterministic resolution algorithm.
- `resolved_plugins` is the complete uniquely keyed set of exact `ResolvedPlugin` entries selected for this workspace. It may be empty when the workspace currently uses only core source, lexical, or other engine capabilities; the lock still pins that deliberate empty resolution.
- `lock_digest` identifies the complete exact resolution, including entries, dependency edges, negotiated contracts, capabilities, and analysis-configuration digests.
- `created_at` is the UTC RFC 3339 timestamp at which the immutable resolution was created; it does not participate in `lock_digest`.

`ResolvedPlugin` fields:

- `plugin_id` is the exact resolved logical-plugin owner and is unique within the lock.
- `plugin_version` is the exact full SemVer selected; locks never contain ranges.
- `namespace` is the namespace exclusively bound to this plugin in the candidate index.
- `package_digest` pins the exact installed package bytes selected for the resolution.
- `declaration_digest` pins the compatibility declaration used by the resolver.
- `contribution_digest` pins the exact registry contribution serialized under the negotiated registry contract.
- `analysis_digest` pins the effective packaged analysis implementation.
- `analysis_configuration_digest` identifies every workspace configuration input capable of changing this plugin's canonical output.
- `plugin_contract_version` is the exact positive integer runtime protocol selected by negotiation.
- `registry_contract_version` is the exact positive integer registry contract selected for this contribution.
- `resolved_dependency_plugin_ids` is the deduplicated set of dependency owners selected in the same lock. The complete dependency graph must be acyclic.
- `effective_capabilities` is the complete set of negotiated `PluginCapabilityDeclaration` values available under the selected package, contracts, dependencies, platform, and workspace configuration.

Resolution considers only locally installed packages or packages made available by explicit local configuration. It never downloads a plugin implicitly. Explicit workspace pins take priority; otherwise Urdira selects the highest stable versions satisfying the complete dependency graph. Prereleases participate only when their requirement permits them. Installing a newer package does not mutate an existing lock.

When two packages have equal SemVer precedence but different full versions or `package_digest` values, Urdira requires an explicit full-version and package-digest pin instead of choosing arbitrarily. Copies with the same full version and digest are the same candidate.

The engine and plugin advertise discrete positive-integer contract versions and select the highest common version unless the existing lock pins another supported value. The selected version is exact and schemas are closed: unknown fields, variants, or enum values are rejected rather than ignored. Different plugins may contribute through different supported registry-contract versions; Urdira losslessly normalizes them into the one assembled contract pinned by `RegistrySnapshot`. Plugin runtime, registry, plugin package, and public query API versions are independent axes.

### Definition revision versus record schema version

Every definition stored in a `RegistrySnapshot`, plus every plugin-compatibility issue-code definition, has two positive monotonic counters:

- `definition_revision` changes for every published modification to the complete definition, including documentation, discovery terms, deprecation, implications, propagation policy, examples, or guidance.
- `schema_version` changes only when the validation contract for stored records or registry values changes.

Metadata-only changes increment `definition_revision` while retaining `schema_version`. Structural schema changes increment both. Neither counter can reset or be reused for the same identifier. A stable semantic meaning change cannot be represented by either counter and requires a new identifier.

Canonical records store `schema_version` because it selects their validation contract. `RegistrySnapshot` selects the exact `definition_revision` used for metadata, mapping, implications, guidance, and query behavior.

### Compatibility assessment models

```text
RegistryCompatibilityAssessment
  assessment_id
  workspace_id
  base_registry_snapshot_id
  base_resolution_lock_id
  candidate_resolution_lock_id
  candidate_registry_digest
  overall_classification
  definition_changes[]
  plugin_analysis_changes[]
  required_actions[]
  assessment_digest
  created_at

DefinitionChangeAssessment
  registry_type
  identifier
  change_type
  from_definition_revision?
  to_definition_revision?
  from_schema_version?
  to_schema_version?
  classification
  reason_codes[]
  required_actions[]
  affected_projection_kinds[]
  explanation

PluginAnalysisChange
  plugin_id
  change_type
  from_plugin_version?
  to_plugin_version?
  from_analysis_digest?
  to_analysis_digest?
  reanalysis_scope
  reason_codes[]
```

`RegistryCompatibilityAssessment` fields:

- `assessment_id` is the immutable identifier of this comparison result.
- `workspace_id` is the workspace whose active and candidate states were compared.
- `base_registry_snapshot_id` is the currently published registry used as the comparison origin.
- `base_resolution_lock_id` is the exact active resolution lock.
- `candidate_resolution_lock_id` is the exact validated candidate resolution lock.
- `candidate_registry_digest` identifies the complete candidate registry before publication.
- `overall_classification` is the strongest of `metadata_only`, `backward_compatible`, `reanalysis_required`, or `new_identifier_required` across every definition and analyzer change.
- `definition_changes` is the complete deterministically ordered set of `DefinitionChangeAssessment` values.
- `plugin_analysis_changes` is the complete deterministically ordered set of `PluginAnalysisChange` values.
- `required_actions` is the deduplicated set containing `rebuild_registry_search`, `rebuild_implication_projection`, `rebuild_derived_projection`, `reanalyze_artifacts`, `close_plugin_records`, or `retire_definitions`; empty means no work beyond publishing the candidate control metadata.
- `assessment_digest` identifies the complete assessment, excluding `assessment_id` and `created_at`.
- `created_at` is the UTC RFC 3339 creation timestamp and does not participate in `assessment_digest`.

`DefinitionChangeAssessment` fields:

- `registry_type` is exactly `canonical_schema`, `digest_domain`, `canonical_comparator`, `external_verification_contract`, `runtime_component`, `digest_recipe`, `digest_reference`, `language`, `capability_contract`, `construct_class`, `capability_limitation`, `record_kind`, `facet`, `semantic_role`, `metric`, `effect`, `diagnostic_code`, `candidate_issue_code`, `dependency_role`, `projection_kind`, `lifecycle_reason`, `completeness_reason`, `semantic_section_kind`, `semantic_reason`, `embedding_profile`, `evidence_assumption`, or `evidence_explanation`.
- `identifier` is the stable namespaced definition identifier being compared.
- `change_type` is `added`, `modified`, `deprecated`, `retired`, or `unchanged`; unchanged entries may be retained only when required to explain an analyzer change.
- `from_definition_revision` is present when the base registry contains the identifier and pins its complete prior definition.
- `to_definition_revision` is present when the candidate registry contains the identifier and pins its complete candidate definition.
- `from_schema_version` is present when the base definition has a stored-value validation contract.
- `to_schema_version` is present when the candidate definition has a stored-value validation contract.
- `classification` is the minimum compatibility class required by this change.
- `reason_codes` is a non-empty deduplicated set of stable machine-readable comparator reasons.
- `required_actions` is the exact deduplicated subset of assessment actions caused by this definition.
- `affected_projection_kinds` is the deduplicated set of derived projection kinds that must be rebuilt; empty means no projection is invalidated directly.
- `explanation` is a bounded human-readable explanation of why the comparator selected the classification. It cannot override `reason_codes`.

`PluginAnalysisChange` fields:

- `plugin_id` is the plugin whose effective analyzer is being added, removed, retained, or changed.
- `change_type` is `added`, `removed`, `unchanged`, or `changed`.
- `from_plugin_version` is present when the plugin exists in the base lock.
- `to_plugin_version` is present when the plugin exists in the candidate lock.
- `from_analysis_digest` is present when the base plugin can produce canonical output.
- `to_analysis_digest` is present when the candidate plugin can produce canonical output.
- `reanalysis_scope` is `none`, `affected_artifacts`, or `all_plugin_artifacts`. `all_plugin_artifacts` means every source artifact selected by the plugin's base or candidate applicability rules, including newly applicable artifacts. The first implementation uses it whenever `analysis_digest` changes; future component-level digests may safely narrow it.
- `reason_codes` is the non-empty deduplicated set explaining the selected scope, including unchanged entries only when another dependency or configuration change invalidates their output.

### Normative compatibility matrix

Urdira computes the minimum permitted classification structurally. A plugin declares its intended classification and a human-readable rationale, but cannot select a weaker result.

| Change | Minimum classification |
|---|---|
| Editorial correction, examples, discovery terms, deprecation metadata, or other non-semantic registry presentation | `metadata_only` |
| New definition, optional payload property, widened allowed value within the same meaning, or new sound implication | `backward_compatible` |
| Required payload property, narrowed schema, identity or anchor change, new required facet, corrected universal mapping, or retirement of a previously emitted value | `reanalysis_required` |
| Category change, stable semantic meaning change, metric algorithm or unit change, emission-condition change, or reuse of any typed-registry identifier for another concept | `new_identifier_required` |

The strongest change controls the assessment. `metadata_only` and `backward_compatible` changes may still rebuild derived projections. `new_identifier_required` rejects the candidate until it uses a new identifier.

`DefinitionChangeAssessment.reason_codes` and `PluginAnalysisChange.reason_codes` use this initial closed vocabulary:

| Reason code | Exact meaning |
|---|---|
| `DEFINITION_ADDED` | The candidate introduces an identifier absent from the base registry. |
| `EDITORIAL_METADATA_CHANGED` | Human-readable wording or examples changed without changing normative meaning or discovery behavior. |
| `DISCOVERY_METADATA_CHANGED` | Search terms or other registry-discovery metadata changed without changing canonical semantics. |
| `DEPRECATION_STATE_CHANGED` | The definition entered or changed its deprecation metadata without becoming retired. |
| `OPTIONAL_PAYLOAD_FIELD_ADDED` | A closed payload schema gained a field that remains optional for new and retained records. |
| `ALLOWED_VALUE_WIDENED` | A validation contract accepts additional values while every previously valid value retains identical meaning. |
| `SOUND_IMPLICATION_ADDED` | A registered facet, role, or effect gained an implication that is always true under its unchanged meaning. |
| `REQUIRED_PAYLOAD_FIELD_ADDED` | New records require a payload field absent from a previously valid schema version. |
| `VALIDATION_SCHEMA_NARROWED` | A previously accepted record or value may fail the candidate validation contract. |
| `IDENTITY_SCHEMA_CHANGED` | Canonical identity fields, relation identity roles, or identity derivation rules changed without changing the stable concept. |
| `RELATION_ANCHOR_CHANGED` | The relation's source ownership or temporal identity anchor changed. |
| `REQUIRED_FACET_ADDED` | Records of the concrete kind must now carry a facet not required previously. |
| `UNIVERSAL_MAPPING_CHANGED` | The concrete kind retains its stable meaning but maps to a different core universal kind and therefore requires regenerated records. |
| `DEFINITION_RETIRED` | The candidate prevents new output under an identifier that the base registry allowed. |
| `CATEGORY_CHANGED` | The identifier would move between universal record categories and therefore cannot retain its stable identity. |
| `STABLE_MEANING_CHANGED` | Normative semantics changed even though no structural comparator rule is more specific. |
| `METRIC_SEMANTICS_CHANGED` | Metric algorithm, unit, numeric type, subject scope, or aggregation semantics changed. |
| `DIAGNOSTIC_SEMANTICS_CHANGED` | Diagnostic category, emission condition, non-meaning, completeness semantics, or required interpretation changed. |
| `ANALYSIS_DIGEST_CHANGED` | The verified packaged analyzer identity changed. |
| `ANALYSIS_CONFIGURATION_CHANGED` | A configuration input capable of changing canonical output changed. |
| `PLUGIN_ADDED` | A plugin absent from the base lock appears in the candidate lock. |
| `PLUGIN_REMOVED` | A plugin present in the base lock is absent from the candidate lock. |
| `DEPENDENCY_ANALYSIS_CHANGED` | A resolved dependency change invalidates this plugin's output even when its own analyzer digest is unchanged. |

An implementation may add core reason codes only through a new registry-contract revision. Unknown reason codes are rejected under the exact negotiated contract.

Schema-compatible plugin upgrades may temporarily mix old and new `producer_version` and `schema_version` values in one current snapshot. The registry retains every referenced definition, and completeness reports upgrade coverage when a query depends on a newly introduced capability. Background reanalysis may converge the index without blocking reads.

`reanalysis_required` upgrades build a candidate generation and do not become the definitive current snapshot until required reanalysis completes. Canonical records are never transformed by plugin-supplied or generic JSON migrations. They are regenerated from the exact source artifact version. Historical snapshots remain unchanged.

Schema compatibility and analyzer compatibility are independent. A changed `analysis_digest` requires `all_plugin_artifacts` reanalysis in the first implementation even when registry schemas are unchanged. A changed `plugin_version` with identical contribution, analysis, package, and analysis-configuration identities does not invalidate canonical knowledge by itself.

Adding a plugin analyzes every artifact selected by its applicability contract. Removing a plugin closes its current records in the candidate generation, reanalyzes dependent contributions when required, and reports any resulting capability loss through candidate completeness. No historical record is physically deleted by the removal.

### Upgrade planning and activation

```text
PluginUpgradePlan
  upgrade_plan_id
  workspace_id
  base_snapshot_id
  base_registry_snapshot_id
  base_resolution_lock_id
  candidate_resolution_lock_id
  compatibility_assessment_id
  work_manifest_id
  publication_policy
  plan_digest
  created_at

PluginActivationAttempt
  activation_attempt_id
  workspace_id
  base_snapshot_id
  base_resolution_lock_id
  upgrade_plan_id?
  candidate_generation_id?
  candidate_materialization_id?
  state
  phase
  completed_work_items
  total_work_items
  candidate_registry_snapshot_id?
  published_snapshot_id?
  compatibility_issue_ids[]
  candidate_issue_ids[]
  started_at
  finished_at?
```

`PluginUpgradePlan` fields:

- `upgrade_plan_id` is the immutable identifier of one executable upgrade, downgrade, or explicit rollback plan.
- `workspace_id` is the only workspace the plan may modify.
- `base_snapshot_id` is the exact published code snapshot from which candidate analysis starts.
- `base_registry_snapshot_id` is the exact published registry being replaced.
- `base_resolution_lock_id` is the exact published plugin resolution being replaced.
- `candidate_resolution_lock_id` is the exact validated resolution to publish if the plan succeeds.
- `compatibility_assessment_id` selects the complete normative comparison governing the plan.
- `work_manifest_id` selects the universal `CandidateWorkManifest` containing the frozen artifact and projection work required by this activation.
- `publication_policy` is `atomic`; no other value is valid in the initial contract.
- `plan_digest` identifies the complete plan excluding `upgrade_plan_id` and `created_at`.
- `created_at` is the UTC RFC 3339 plan-creation timestamp and does not participate in `plan_digest`.

`PluginActivationAttempt` fields:

- `activation_attempt_id` is the immutable identifier of one administrative activation attempt, including attempts that fail before a plan can be produced.
- `workspace_id` is the target workspace.
- `base_snapshot_id` is the published snapshot that remains readable until successful atomic publication.
- `base_resolution_lock_id` is the active lock at attempt start.
- `upgrade_plan_id` is present after resolution, negotiation, validation, and assessment produce an executable plan; it is omitted when an earlier phase fails.
- `candidate_generation_id` is present after an `IndexCandidate` is created for the executable plan and is omitted when activation fails before candidate planning.
- `candidate_materialization_id` is present only while or after private staged candidate output exists. It never identifies a `Snapshot`.
- `state` is `pending`, `running`, `failed`, `published`, or `cancelled`.
- `phase` is `resolution`, `negotiation`, `declaration_validation`, `registry_validation`, `compatibility_assessment`, `candidate_planning`, `candidate_analysis`, `candidate_validation`, `candidate_projection`, `publication`, or `cleanup`.
- `completed_work_items` is the non-negative number of manifest items completed in the current attempt.
- `total_work_items` is the non-negative frozen number of manifest items, is zero before a work manifest exists, and is never lower than `completed_work_items`.
- `candidate_registry_snapshot_id` is present after the candidate registry snapshot is materialized.
- `published_snapshot_id` is present exactly when `state` is `published` and identifies the atomically installed code snapshot.
- `compatibility_issue_ids` is the deduplicated deterministically ordered set of `PluginCompatibilityIssue` occurrences produced before candidate execution. Candidate planning, analysis, validation, projection, publication, and cleanup failures never enter this set.
- `candidate_issue_ids` is the deduplicated deterministically ordered set of `CandidateIssue` occurrences produced after `candidate_generation_id` exists. It is empty when activation ends before candidate creation.
- `started_at` is the UTC RFC 3339 attempt-start timestamp.
- `finished_at` is required for `failed`, `published`, or `cancelled` and omitted for `pending` or `running`.

Upgrade, downgrade, and explicit rollback use the same pipeline: resolve a candidate lock, negotiate exact contracts, validate the complete registry, assess compatibility, freeze work, build and validate a candidate generation, and atomically publish code snapshot, registry snapshot, and resolution lock. Failure leaves the previous published state unchanged. Existing query executions and cursors remain pinned to their old snapshots until expiration.

A downgrade never reuses records produced by a later analyzer merely because its package version is lower. It applies the same digest and compatibility rules as an upgrade. If both contribution and analyzer identities are unchanged, no canonical rewrite is required.

### Definition retirement

Definitions move through `active`, `deprecated`, `retired`, and `collected` states. Deprecated definitions may still produce records and provide an optional replacement. Retired definitions cannot produce new records but remain available while referenced. Collection occurs only after no retained snapshot, record, dependency, or query execution needs the definition. Identifiers remain permanently reserved after collection.

Renaming creates a new identifier and deprecates the previous one. A replacement field is guidance, not an alias. Exact queries for retained old identifiers remain valid. Candidate activation fails when it retires a definition still required by another active plugin; new dependencies on retired definitions are invalid, while dependencies on deprecated definitions produce a compatibility warning.

### Compatibility issues

```text
PluginCompatibilityIssueCodeDefinition
  code
  definition_revision
  schema_version
  title
  description
  non_meaning
  emission_condition
  allowed_phases[]
  default_severity
  allowed_severities[]
  payload_schema
  allowed_required_actions[]
  default_retryable
  retryable_condition?
  agent_guidance
  examples[]
  lifecycle_state
  deprecated_since?
  retired_since?
  replacement_code?

RegistryDefinitionReference
  registry_type
  identifier
  definition_revision

CompatibilityRequirementReference
  requirement_type
  declaring_plugin_id?
  target_plugin_id?
  capability?
  requirement_digest

PluginCompatibilityIssue
  issue_id
  code
  severity
  phase
  plugin_ids[]
  definition_references[]
  requirement_references[]
  summary
  detail?
  payload
  required_action
  retryable
  created_at
```

`PluginCompatibilityIssueCodeDefinition` fields:

- `code` is the stable uppercase snake-case control-plane identifier.
- `definition_revision` is the positive monotonic revision of the complete code definition and increases for every published change.
- `schema_version` is the positive monotonic version of the issue occurrence and payload validation contract; metadata-only changes retain it.
- `title` is the short stable display name.
- `description` defines exactly what an occurrence means.
- `non_meaning` defines conclusions that cannot be inferred from an occurrence.
- `emission_condition` is the exact necessary condition under which Urdira may emit the code.
- `allowed_phases` is the non-empty closed set of activation phases in which the condition can be detected.
- `default_severity` is the ordinary `warning` or `error` severity and belongs to `allowed_severities`.
- `allowed_severities` is the non-empty closed set of legal severities for occurrences.
- `payload_schema` is the closed schema for `PluginCompatibilityIssue.payload`, including every presence, type, enum, and interaction rule.
- `allowed_required_actions` is the non-empty closed set of administrative actions an occurrence may request and includes its documented default.
- `default_retryable` states whether retrying without any external or state change ordinarily can succeed.
- `retryable_condition` is required when occurrences may override `default_retryable` and states the exact machine-verifiable condition for doing so; it is omitted when retryability is fixed.
- `agent_guidance` is the concise interpretation and next action useful to a coding agent inspecting index status.
- `examples` contains at least one complete valid occurrence.
- `lifecycle_state` is `active`, `deprecated`, or `retired` and controls whether new issue occurrences may use this code.
- `deprecated_since` is required for deprecated or retired codes and identifies the first discouraging `definition_revision`; it is omitted for active codes.
- `retired_since` is required exactly for retired codes and identifies the first revision forbidding new occurrences.
- `replacement_code` is the optional replacement for a deprecated or retired code and is omitted for active codes.

`RegistryDefinitionReference` fields:

- `registry_type` is exactly `canonical_schema`, `digest_domain`, `canonical_comparator`, `external_verification_contract`, `runtime_component`, `digest_recipe`, `digest_reference`, `language`, `capability_contract`, `construct_class`, `capability_limitation`, `record_kind`, `facet`, `semantic_role`, `metric`, `effect`, `diagnostic_code`, `candidate_issue_code`, `dependency_role`, `projection_kind`, `lifecycle_reason`, `completeness_reason`, `semantic_section_kind`, `semantic_reason`, `embedding_profile`, `evidence_assumption`, or `evidence_explanation`.
- `identifier` is the stable namespaced definition identifier.
- `definition_revision` pins the exact complete definition implicated by the issue.

`CompatibilityRequirementReference` fields:

- `requirement_type` is `plugin_version`, `plugin_contract`, `registry_contract`, `capability_contract`, `namespace_binding`, `package_integrity`, or `retained_decoder`.
- `declaring_plugin_id` identifies the plugin that declared the requirement and is present for every plugin-originated requirement; it is omitted only for an engine-owned retained-decoder requirement.
- `target_plugin_id` identifies the plugin expected to satisfy a dependency, capability, namespace, or package requirement and is omitted for engine-contract and retained-decoder requirements.
- `capability` identifies the required capability and is present exactly for `capability_contract`; it is omitted for every other type.
- `requirement_digest` identifies the complete canonical requirement or engine constraint referenced by the issue.

`PluginCompatibilityIssue` fields:

- `issue_id` is the immutable identifier of one control-plane issue occurrence.
- `code` is a stable value registered in the compatibility-issue registry.
- `severity` is `warning` or `error` and must be allowed by the selected code definition.
- `phase` is one activation phase allowed by the selected code definition.
- `plugin_ids` is the deduplicated set of directly implicated plugins and satisfies the selected code's cardinality rules.
- `definition_references` is the deduplicated set of typed registry definition references implicated by the issue; empty is valid only when the code is not definition-specific.
- `requirement_references` is the deduplicated set of dependency, version, contract, or capability requirement references implicated by the issue; empty is valid only when the code does not concern a requirement.
- `summary` is a required bounded human-readable statement of the concrete occurrence.
- `detail` is optional bounded explanatory text and cannot introduce semantics absent from the code or payload.
- `payload` is the closed typed object selected by the issue-code definition.
- `required_action` is the code-permitted administrative action needed to proceed, or `none` for a warning that does not block activation.
- `retryable` states whether repeating the same attempt can succeed without changing packages, configuration, contracts, definitions, source, or persistent storage state. It equals the selected code's default unless that code's `retryable_condition` permits the occurrence-specific value.
- `created_at` is the UTC RFC 3339 occurrence timestamp.

`required_action` uses this closed initial vocabulary:

| Action | Exact meaning |
|---|---|
| `none` | The occurrence is informational or advisory and does not block activation by itself. |
| `resolve_namespace_conflict` | Select or configure one owner for the conflicting namespace in this index. |
| `select_compatible_version` | Change installed versions, dependency requirements, or exact pins so one deterministic version can resolve. |
| `remove_dependency_cycle` | Change at least one plugin dependency edge to make the resolved graph acyclic. |
| `install_capability_provider` | Make a provider satisfying the required capability contract locally available and selectable. |
| `update_plugin_or_engine` | Install or select plugin and engine versions with a common exact contract. |
| `repair_plugin_declaration` | Correct and republish the invalid bootstrap compatibility declaration. |
| `reinstall_or_repin_package` | Restore package bytes matching the pin or explicitly select the intended full version and digest. |
| `repair_registry_contribution` | Correct and republish the atomic registry contribution. |
| `publish_new_identifier` | Register the changed concept under a new identifier and deprecate the previous definition when appropriate. |
| `update_dependency` | Change a dependent plugin so it no longer requires a deprecated or retired definition. |
| `restore_compatible_decoder` | Use an engine or lossless adapter chain capable of interpreting every retained contract. |

Compatibility issues are pre-execution control-plane state, not `DiagnosticRecord` knowledge, because they concern package resolution, negotiation, declarations, registry compatibility, or retained decoders. Once an `IndexCandidate` exists, every planning, analysis, validation, projection, publication, or cleanup condition uses `CandidateIssue` exclusively. Candidate failures never inject diagnostics into the published snapshot. Source-specific limitations from valid output of an active plugin continue to use the diagnostic model.

The initial codes, exact payloads, emission conditions, severities, phases, recovery actions, and examples are defined in [Plugin compatibility issue codes](../compatibility/plugin-compatibility-issue-codes.md).

### Logical immutability and physical migrations

Historical records and definitions never change meaning or logical identity. Urdira may migrate their physical storage representation only through deterministic lossless core adapters. A `RegistrySnapshot` retains its original logical contract version after physical migration.

Before opening an index for writes, an engine upgrade verifies that every retained snapshot and active query execution has a supported decoder or a complete lossless adapter chain. Without one, Urdira preserves the index, refuses write activation, and reports the required administrative action; it never deletes retained history automatically. Physical migration transactions and recovery belong to the storage specification.

Activation validates the entire contribution and dependency closure before publishing a `RegistrySnapshot`. Validation includes ownership, identifier syntax, typed-registry collisions, runtime-component implementation and contract bindings, schemas, universal mappings, relation specialization, implications, incompatibilities, and dependency references. Any failure rejects the entire contribution; no partial registration is observable. Runtime emission of an unregistered or invalid value rejects the candidate delta and records the exact `CandidateIssue`; it never creates canonical knowledge from rejected output.

Every immutable code `Snapshot` references exactly one `registry_snapshot_id`. Validated definitions are copied into the index rather than loaded on demand from installed plugin files. Removing a plugin therefore cannot make retained snapshots or cursor-pinned executions uninterpretable. Definitions remain until no retained snapshot, record, or query execution references them; exact retirement and garbage-collection behavior belongs to the temporal-lifecycle decision.

#### Registry inclusion in agent responses

```text
RegistryIncludeOptions
  registry
  include_payload_schemas

KindDefinitionView
  kind
  category
  definition_revision
  schema_version
  description
  universal_kind
  required_facets[]
  allowed_facets[]
  relation_definition?
  payload_schema?
  plugin_owner?
  lifecycle_state
  deprecated_since?
  retired_since?
  replacement_kind?

RegistryBundle
  registry_usage_set_id?
  language_definitions[]
  capability_contract_definitions[]
  construct_class_definitions[]
  capability_limitation_definitions[]
  kind_definitions[]
  facet_definitions[]
  semantic_role_definitions[]
  metric_definitions[]
  effect_definitions[]
  diagnostic_code_definitions[]
  candidate_issue_code_definitions[]
  dependency_role_definitions[]
  projection_kind_definitions[]
  lifecycle_reason_code_definitions[]
  completeness_reason_definitions[]
  semantic_section_kind_definitions[]
  semantic_reason_definitions[]
  evidence_assumption_definitions[]
  evidence_explanation_definitions[]
  has_more
  cursor?

RegistryUsageSet
  registry_usage_set_id
  query_execution_id
  parent_slices[]
  registry_snapshot_ids[]
  definition_set
  usage_set_digest

RegistryUsageParentSlice
  result_stream
  stable_start_position
  stable_end_position_exclusive
  projection_digest
```

`RegistryIncludeOptions` fields:

- `registry` is `none`, `used`, or `full` and defaults to `used`. `none` omits only the registry stream and never disables other pagination. `used` creates one immutable page-specific `RegistryUsageSet`; `full` selects the complete agent-queryable definition scope listed by `RegistryBundle`. Both selected modes support independent pagination. Canonical schemas, hash algorithms, digest domains, comparators, verifier contracts, runtime components, recipes, references, and embedding profiles remain available through separate administrative/schema introspection and are not silently mixed into this bundle.
- `include_payload_schemas` is a boolean defaulting to false. When true, full payload schemas may be hydrated within the response budget.

`KindDefinitionView` fields:

- `kind` identifies the concrete registered kind represented by this view.
- `category` is its universal record category.
- `definition_revision` identifies the exact complete registry definition selected by the pinned query execution.
- `schema_version` identifies the record-validation and payload contract used by records of this kind.
- `description` defines the kind's concise semantics and boundary.
- `universal_kind` is its one core base mapping.
- `required_facets` is the complete set every record of this kind carries.
- `allowed_facets` is the complete set from which context-dependent record facets may be selected.
- `relation_definition` is present exactly for relation kinds and contains their registered role, cardinality, target, order, anchor, and identity schema.
- `payload_schema` is present exactly when `include_payload_schemas` is true. Taxonomy pagination keeps a definition atomic; if one complete schema exceeds the configured single-item limit, Urdira returns a structured size error instead of truncating the schema.
- `plugin_owner` is present for plugin-owned kinds and omitted for core kinds.
- `lifecycle_state` is the exact active, deprecated, or retired state in the pinned registry snapshot.
- `deprecated_since` and `retired_since` follow the canonical definition-revision presence rules.
- `replacement_kind` is present when a deprecated or retired kind declares a semantic replacement and omitted otherwise.

`RegistryBundle` fields:

- `registry_usage_set_id` is required exactly for `used`, identifies the immutable page-specific definition set, and is forbidden for `full`. No bundle exists for `none`.
- `language_definitions` and `capability_contract_definitions` contain selected agent-queryable language and behavioral-contract definitions.
- `construct_class_definitions` and `capability_limitation_definitions` contain definitions referenced by the page or explicitly selected through registry discovery.
- `kind_definitions` contains deduplicated `KindDefinitionView` values selected by the inclusion mode.
- `facet_definitions` contains deduplicated definitions for selected facets.
- `semantic_role_definitions` contains deduplicated definitions for selected semantic-role values.
- `metric_definitions` contains deduplicated definitions for selected metric values.
- `effect_definitions` contains deduplicated definitions for selected effect values.
- `diagnostic_code_definitions` and `candidate_issue_code_definitions` contain selected source-diagnostic and candidate-control definitions without mixing their occurrence domains.
- `dependency_role_definitions` and `projection_kind_definitions` contain selected invalidation and derived-projection contracts.
- `lifecycle_reason_code_definitions` and `completeness_reason_definitions` contain selected transition and coverage reason definitions.
- `semantic_section_kind_definitions` and `semantic_reason_definitions` contain every selected agent-queryable semantic contract used by the current response page or the full selected registry scope.
- `evidence_assumption_definitions` and `evidence_explanation_definitions` contain selected evidence interpretation contracts.
- `has_more` is true exactly when additional selected registry definitions remain beyond this bundle.
- `cursor` is present exactly when `has_more` is true and continues the registry stream pinned to the same snapshot and plugin versions.

`RegistryUsageSet` is owned by one ready `QueryExecution`. `parent_slices` is a non-empty canonical set of the hydrated result, evidence, diagnostic, completeness, semantic-coverage, or snippet stream slices whose values require the definitions. Each slice uses half-open stable positions and repeats its projection digest. `registry_snapshot_ids` is the complete canonical set selected by the execution. `definition_set` is an `OrderedSetDescriptor` over exact registry definition coordinates. `usage_set_digest` covers every semantic field except `registry_usage_set_id` and itself. The first used bundle and every registry continuation repeat the ID; continuation therefore never infers “used” from summary-only parent streams. An empty used set is represented explicitly with no cursor.

#### Agent-facing registry discovery

An agent is not required to know installed namespaces or plugin identifiers before querying records. The active `RegistrySnapshot` is a first-class source in the composed-query algebra.

A registry-selection stage can filter the agent-queryable definition types enumerated below by typed registry, exact identifier, optional namespace, optional plugin owner, record category, universal kind, facets, implications, deprecation state, and concept text. Omitting the namespace searches every active and retained matching definition in the pinned registry. Exact and normalized lexical matching are deterministic. Semantic or hybrid definition discovery must be explicitly selected, pins its model version in the query execution, and supplies candidates rather than structural proof.

Later stages consume the typed identifiers selected by the registry stage, including languages, versioned capability contracts, construct classes, capability limitations, kinds, facets, semantic roles, metrics, effects, diagnostic codes, candidate issue codes, dependency roles, projection kinds, lifecycle reasons, completeness reasons, semantic section kinds, semantic reasons, evidence assumptions, and evidence explanations. Languages and capabilities are ordinary agent-queryable definitions; construct and limitation definitions are returned when referenced or explicitly selected. Embedding profiles are deliberately excluded because normal agent queries neither select them nor need to discover their identifiers. An inline definition matcher is syntactic sugar for a registry-selection stage followed by the consuming operation. This allows one request to discover an unfamiliar plugin concept and retrieve matching records without a prior namespace-listing call.

The result includes the selected definitions, their namespace and `plugin_owner` when that family has one, their universal mappings or sound implications, and the exact match reasons. Shared languages omit owner and expose supplier associations only through administrative detail. Query execution persists the resolved definition set under `registry_snapshot_id`; continuation pages cannot observe newly installed, removed, or upgraded plugins. Namespace enumeration and full registry inspection remain available and paginated, but are never prerequisites for ordinary data queries.

An exact identifier absent from the pinned registry is a structured request error rather than a valid empty result. A concept search that validly selects no definition returns an empty result with its searched registry scope, allowing the agent to distinguish "no matching concept" from "no records of a known concept."

The approved initial catalog is defined in [Core taxonomy](../taxonomy/core-taxonomy.md). Representative mappings include:

```text
typescript:class -> core:type
rust:trait -> core:type
python:function -> core:callable
sql:table -> core:resource
nestjs:route_handler_binding -> core:binds
jest:test_role -> core:semantic_role
```

## Approved source catalog model

### Artifact identity

`SourceArtifact` identifies a normalized source address within exactly one workspace. It does not attempt to track physical-file identity through inodes, Git rename heuristics, or filesystem event history.

Its logical identity is equivalent to:

```text
workspace_id + normalized_uri
```

Changing content at the same address preserves the artifact identity. A canonical rename is deletion of the old address and creation of the new address. Optional lineage evidence may relate the two artifacts, but it cannot change their canonical identities.

This rule keeps full reindexing deterministic even when rename events or Git history are unavailable.

### SourceArtifact

```text
SourceArtifact
  artifact_id
  workspace_id
  normalized_uri
  normalized_path?
  display_path?
  artifact_kind
```

Required logical constraints:

```text
UNIQUE (workspace_id, normalized_uri)
INDEX  (workspace_id, normalized_path)
```

Initial artifact kinds are:

```text
physical_file
virtual_file
external_source
generated_source
archive_member
language_builtin
```

Physical workspace artifacts retain an exact normalized workspace-relative path. Virtual artifacts use provider-owned normalized URIs and remain workspace-scoped so that different compiler or dependency configurations cannot be mixed accidentally.

### ArtifactVersion

`ArtifactVersion` identifies one exact, contiguous occurrence of content at an artifact address:

```text
ArtifactVersion
  artifact_version_id
  workspace_id
  artifact_id
  content_blob_id
  content_hash
  byte_length
  encoding
  language_hint?
  analysis_metadata_digest
  created_from_observation_id
  valid_from_generation
  valid_to_generation?
```

An artifact version is immutable except for the one-way assignment of `valid_to_generation`. Its interval is half-open. Repeated observations with the same content and analysis-relevant metadata reuse the current version and do not publish an empty generation. Content, encoding, language classification, or analysis-relevant metadata changes create another version. Deleting an artifact closes its current version. Recreating or reincluding the same address always creates another version, even if every content digest is identical; identical content may still reuse the same content blob. Timestamps and other analysis-irrelevant provider metadata do not force a new version.

### ContentBlob

Content is reusable independently from artifact identity:

```text
ContentBlob
  content_blob_id
  content_hash
  byte_length
  storage_reference
```

Logical uniqueness is equivalent to:

```text
UNIQUE (content_hash, byte_length)
```

`content_hash` is a canonical `Digest` and therefore already contains its algorithm identifier. It covers the exact raw source bytes under the registered artifact-content recipe. `byte_length` is the exact raw byte count and `storage_reference` is a private physical locator excluded from the content digest. Related workspaces can share stored content while retaining separate artifacts, versions, knowledge records, and resolved relationships.

### SourceSpan

A source span refers to one exact artifact version:

```text
SourceSpan
  artifact_version_id
  start_byte
  end_byte
  start_line?
  end_line?
```

Byte offsets use half-open intervals, `[start_byte, end_byte)`, and are the canonical coordinates for snippet extraction and hashing. Optional presentation lines and columns are one-based Unicode-scalar coordinates derived from the exact decoded artifact version; tabs count as one scalar and line endings follow the decoded source. They never participate in identity, hashing, or plugin input.

### Artifact lifecycle

- **Modification:** close the current artifact version and create a new version at the same artifact address.
- **Deletion:** close the current artifact version and invalidate owned and dependent knowledge records in the new generation.
- **Creation:** resolve or create the artifact address and create its first current version.
- **Rename:** close the old address and create a new artifact and version at the new address.

Rename lineage may be recorded through evidence such as `git_rename`, `filesystem_rename_event`, or `content_similarity`. Lineage is informational and does not affect canonical identity.

### Source observations and authoritative absence

```text
SourceObservationBatch
  observation_batch_id
  workspace_id
  source_provider_binding_id
  source_provider
  source_provider_version
  ordering_domain
  observation_mode
  coverage_scopes[]
  coverage_completeness
  deletion_authority
  provider_cursor_before?
  provider_cursor_after?
  started_at
  completed_at
  observation_count
  unavailable_count
  batch_digest

SourceObservation
  source_observation_id
  observation_batch_id
  workspace_id
  artifact_id
  source_provider_binding_id
  source_provider
  source_provider_version
  ordering_domain
  observation_mode
  observed_state
  observed_content_hash?
  observed_metadata_digest?
  provider_event_token?
  provider_sequence?
  observed_at
  received_at

SourceObservationDigestEntry
  artifact_id
  observed_state
  observed_content_hash?
  observed_metadata_digest?
  provider_event_token?
  provider_sequence?

ObservationCoverageScope
  scope_type
  source_provider_binding_id
  source_provider
  normalized_scope_key

ChangeCauseReference
  cause_type
  cause_id

VisibleSourceStateEntry =
  PresentSourceStateEntry |
  AbsentSourceStateEntry

PresentSourceStateEntry
  state_kind = present
  workspace_id
  artifact_id
  normalized_uri
  artifact_kind
  artifact_version_id
  content_hash
  byte_length
  encoding
  language_hint?
  analysis_metadata_digest
  valid_from_generation

AbsentSourceStateEntry
  state_kind = absent
  workspace_id
  artifact_id
  normalized_uri
  artifact_kind
  artifact_tombstone_id
  absence_kind
  absence_reason_code
  last_artifact_version_id
  valid_from_generation
```

`ordering_domain` is exact `Text` naming the provider-local stream or scan domain and must match between a batch and every contained observation. `observation_mode` is `event`, `scan`, or `reconciliation`. `observed_state` is `present`, `deleted`, or `unavailable`; exclusion is caused by configuration rather than inferred by a source provider. Every observation carries an indexed `artifact_id`, including deletion and read failure. Provider event tokens deduplicate when available, and non-negative provider sequences preserve order only inside one `source_provider_binding_id + source_provider + source_provider_version + ordering_domain` without becoming workspace generations. A `SourceObservationBatch` enters the persistent logical model only after completion; provider-side in-progress collection is transient and has no authoritative `batch_digest`.

`SourceObservationDigestEntry` is the exact normalized observation value committed by `SourceObservationBatch.batch_digest`. Batch-level workspace, provider binding, provider, provider version, ordering domain, and observation mode are not repeated. Occurrence IDs, batch IDs, `observed_at`, and `received_at` are excluded because they do not change the observed source state. Every remaining field is copied exactly from `SourceObservation`, including optional-field presence. Entries are deduplicated before `observation_count` is finalized; two otherwise equal provider events remain distinct only when their provider token or sequence distinguishes them.

| `SourceObservationDigestEntry` field | Exact meaning |
|---|---|
| `artifact_id` | Indexed exact artifact address observed inside the batch workspace. |
| `observed_state` | Exact copied `present`, `deleted`, or `unavailable` state. |
| `observed_content_hash` | Optional copied raw-content digest with the same presence contract as the source observation. |
| `observed_metadata_digest` | Optional copied analysis-relevant metadata digest with the same presence contract as the source observation. |
| `provider_event_token` | Optional provider-owned opaque `Bytes` deduplication token copied exactly from the source observation. |
| `provider_sequence` | Optional non-negative `BigInteger` copied from the source observation; it orders only events in the same provider ordering domain. |

`VisibleSourceStateEntry` is the closed snapshot-source-state union used by `Snapshot.source_state_digest`. The present variant copies the stable source address plus every analysis-relevant immutable field of the visible `ArtifactVersion`. The absent variant copies the address and immutable opening state of the visible `ArtifactTombstone`. Both exclude `valid_to_generation` and every tombstone closing field, so later monotonic closure cannot change a retained snapshot digest. `normalized_path` and `display_path` are derivable address projections and are excluded; `normalized_uri` is the canonical artifact identity coordinate.

| Visible source-state field | Exact meaning |
|---|---|
| `state_kind` | Required discriminator, `present` or `absent`. |
| `workspace_id`, `artifact_id`, `normalized_uri`, `artifact_kind` | Exact immutable source address and kind copied from `SourceArtifact`. |
| `artifact_version_id` | Exact visible present occurrence; required only for `present`. |
| `content_hash`, `byte_length`, `encoding`, `language_hint`, `analysis_metadata_digest` | Exact analysis-relevant present-state values copied from that artifact version, with identical optionality. |
| `artifact_tombstone_id` | Exact visible absence occurrence; required only for `absent`. |
| `absence_kind`, `absence_reason_code`, `last_artifact_version_id` | Exact immutable tombstone opening state, required only for `absent`. |
| `valid_from_generation` | Opening generation of the selected artifact version or tombstone. |

Batch coverage is explicit. `coverage_completeness` is `complete`, `partial`, or `failed`. Only a complete batch with deletion authority may infer deletion from absence inside its exact coverage scopes. An explicit authoritative deletion event may confirm its own deletion. Partial or failed scans may confirm presence but cannot remove unobserved artifacts. `unavailable` records degraded freshness and never closes knowledge or creates a tombstone.

A confirmed `deleted` observation or configuration-driven exclusion is a non-coalescible lifecycle barrier. Once accepted as authoritative, later presence at the same artifact address cannot be reduced to `updated`, even when it is observed before indexing has published the absence. The planner preserves the ordered absence and presence transitions and publishes two consecutive generations: the first closes the prior artifact version and opens its tombstone, and the second closes that tombstone and opens a newly allocated artifact version. Presence observations may be coalesced with other presence observations only while no confirmed absence barrier occurs between them.

Coverage scope type is `artifact`, `uri_prefix`, `source_root`, or `virtual_collection`. Its normalized key is interpreted only by the named registered source provider. Cause type is `source_observation`, `artifact_change`, `artifact`, `artifact_version`, `artifact_tombstone`, `record`, `configuration_revision`, `registry_snapshot`, `reconciliation_run`, or `recovery_event`; `cause_id` must resolve to the exact object selected by that discriminator and workspace.

### Artifact transitions and tombstones

```text
ArtifactChange
  artifact_change_id
  workspace_id
  artifact_id
  change_kind
  previous_artifact_version_id?
  new_artifact_version_id?
  previous_tombstone_id?
  new_tombstone_id?
  cause_references[]
  lineage_evidence_record_ids[]

ArtifactTombstone
  artifact_tombstone_id
  workspace_id
  artifact_id
  absence_kind
  absence_reason_code
  last_artifact_version_id
  valid_from_generation
  valid_to_generation?
  opening_artifact_change_id
  closing_artifact_change_id?
  replacement_artifact_version_id?
  cause_references[]
  lineage_evidence_record_ids[]
```

`ArtifactChange.change_kind` has a closed transition table:

| Kind | Previous state | New state |
|---|---|---|
| `created` | None | New artifact version |
| `updated` | Artifact version | New artifact version, without absence |
| `deleted` | Artifact version | Open `deleted` tombstone |
| `excluded` | Artifact version | Open `excluded` tombstone |
| `recreated` | `deleted` tombstone | New artifact version |
| `reincluded` | `excluded` tombstone | New artifact version |

The conditional version and tombstone fields must match this table exactly. `cause_references` uses the complete `ChangeCauseReference` union defined above. A rename is a delete and a create with optional deterministic lineage evidence; heuristic similarity cannot preserve canonical identity.

`ArtifactTombstone.absence_kind` is `deleted` or `excluded`. Its interval is half-open, closure is monotonic, and each absence cycle creates a new tombstone. Closing fields appear together when the artifact is recreated or reincluded. An open tombstone is never eligible for garbage collection. Absence reason codes are stable, namespaced, registered, and discoverable.

Because confirmed absence is published before later presence, a recreated or reincluded artifact always has a base tombstone rather than an active base artifact version. Identity assignment therefore cannot continue any entity, relation, or diagnostic lifecycle that the absence generation closed. Recreated content allocates new lifecycle and occurrence identifiers even when every semantic key and content digest matches the pre-absence state.

## Approved entity identity model

### Versioned semantic identity

An entity has a workspace-scoped semantic identity shared by its temporal record versions. Named entities use reproducible semantic keys; structurally anchored entities declare best-effort stability; ephemeral entities are scoped to one artifact version. Renames, moves, and cross-workspace matches use explicit correspondence evidence rather than silently preserving identity.

Urdira does not create an ownerless global `EntityIdentity` knowledge record. Every entity version remains a complete, source-owned knowledge record. Temporal versions are correlated through a shared `entity_id` field.

The logical model is:

```text
EntityRecord extends RecordEnvelope
  entity_id
  semantic_key
  portable_symbol_key?
  identity_stability
```

`record_id` identifies one exact canonical record version. `entity_id` groups record versions that represent the same semantic entity within one workspace.

Logical indexes must support lookups equivalent to:

```text
(workspace_id, entity_id, valid_to_generation)
(workspace_id, semantic_key, valid_to_generation)
(workspace_id, owner_artifact_id, kind, valid_to_generation)
(workspace_id, universal_kind, valid_to_generation)
(workspace_id, facet, valid_to_generation)
```

### Semantic keys

A plugin produces a reproducible semantic key for every entity that can be identified independently from source offsets. A named TypeScript method may use a key equivalent to:

```text
typescript:module/src/auth/session#SessionService.refresh
```

Semantic-key inputs are:

```text
language
semantic_module
containing_symbol_chain
declaration_kind
declared_name
overload_or_role_discriminator
```

Offsets and line numbers are forbidden as inputs for stable semantic keys. Signatures are excluded unless the language requires a signature component to distinguish declarations such as overloads.

`semantic_key` is a deterministic lookup and correlation key, not the entity identifier. Plugins produce semantic keys; the core assigns `entity_id` after all candidate deltas have been combined. If a compatible identity is active in the base snapshot, a changed record may continue it. If no compatible active identity exists, the core allocates a new `entity_id`. A key belonging only to a closed identity never reopens that identity.

The allocation and assignment are recorded in the generation manifest. Plugins must produce the same semantic key for unchanged semantics during a full reindex. Rebuilding while preserving the source catalog and history preserves active identities; creating an entirely new index creates new identity values even for equivalent source.

### Identity stability

Every entity declares one of three stability levels:

```text
stable
best_effort
ephemeral
```

#### Stable

The compiler or analyzer identifies the declaration semantically. Typical examples include named functions, classes, methods, types, exports, and fields.

#### Best effort

The entity is anonymous but has a useful structural anchor. Typical examples include anonymous callbacks, object-literal methods, anonymous classes, and lambdas assigned to variables.

A best-effort key may use:

```text
enclosing_semantic_key
structural_role
local_discriminator
syntax_fingerprint
```

The producer must not report best-effort identity as guaranteed continuity.

#### Ephemeral

The entity represents an expression, control-flow node, implicit construct, or synthetic analyzer node whose identity is valid only for one artifact version. Its identity may include `owner_artifact_version_id` and does not promise continuity after an edit.

### Entity lifecycle

- **Internal implementation change:** create a new entity record version with the same `entity_id` when the semantic key is unchanged.
- **Rename:** close the old entity and create a new semantic identity. Optional `RENAMED_FROM` evidence may relate them.
- **Move:** close the old entity and create a new semantic identity when its semantic module or artifact changes. Optional `MOVED_FROM` evidence may relate them.
- **Signature change:** preserve identity when the declaration remains semantically the same, except where signatures distinguish overload identities.
- **Deletion:** close the current entity record and invalidate dependent records in the new generation.
- **Reappearance after deletion:** create a new `entity_id` and `record_id`, even when content and semantic key are identical. Optional evidence may state `recreated_from`, but cannot merge the lifecycles.

An `entity_id` represents one uninterrupted lifecycle. Once closed, it is never reopened. Correspondence evidence is informative and cannot rewrite historical entity identities.

Identity categories are explicit:

- `artifact_id` is an address identity and may survive absence cycles at the same normalized URI.
- `entity_id`, `relation_id`, and `diagnostic_id` are uninterrupted lifecycle identities and never reopen.
- `record_id`, `artifact_version_id`, `artifact_tombstone_id`, `projection_record_id`, and `snapshot_id` identify immutable versions or occurrences and are always newly allocated.
- `semantic_key`, `relation_key`, and `diagnostic_key` are reproducible matching inputs, not proof of lifecycle continuity.

### Workspace isolation and portable correlation

Entity identity is always scoped to one workspace. Equivalent declarations in two worktrees or clones have different `entity_id` values and cannot be combined by ordinary single-workspace queries.

Plugins may additionally emit a `portable_symbol_key` to help explicit comparison operations correlate declarations across workspaces. A portable key is a matching input, not an identity and not proof of equivalence.

Concrete serialized entity fixtures belong to the UCE conformance corpus. The abstract `EntityRecord` shape above is authoritative and no alternate camel-case envelope is defined.

## Reverse artifact dependencies

Cross-file derivations require more than one owner field. The candidate reverse-dependency record is:

```text
RecordArtifactDependency
  dependency_entry_id
  workspace_id
  record_id
  owner_artifact_id
  owner_artifact_version_id
  dependency_artifact_id
  dependency_artifact_version_id
  dependency_role
  producer_id
  producer_version
  valid_from_generation
  valid_to_generation?

RecordArtifactDependencyDigestEntry
  workspace_id
  record_id
  owner_artifact_id
  owner_artifact_version_id
  dependency_artifact_id
  dependency_artifact_version_id
  dependency_role
  producer_id
  producer_version
  valid_from_generation
```

Example: a call relation is owned by the artifact containing its call site and additionally depends on the artifact containing the resolved target definition.

The dependency entry has exactly the same half-open interval as its canonical `record_id` and opens and closes atomically with it. Logical uniqueness is `record_id + dependency_artifact_version_id + dependency_role`. The complete canonically ordered `RecordArtifactDependencyDigestEntry` set participates in `artifact_dependency_digest`. It copies every immutable semantic and provenance field while excluding `dependency_entry_id`, which only addresses the materialized reverse-index row, and `valid_to_generation`, which is assigned monotonically after the digest was created. Dependency roles are registered, namespaced values. Every external artifact capable of changing a record must appear; when an exact artifact cannot be enumerated, the plugin uses a broader registered invalidation fallback rather than inventing a dependency.

| Field | Exact meaning |
|---|---|
| `dependency_entry_id` | Immutable identity of the materialized reverse-index entry. |
| `workspace_id` | Workspace containing owner, dependency, and record. |
| `record_id` | Exact canonical record whose derivation depends on the artifact. |
| `owner_artifact_id` | Indexed primary owner copied from the record. |
| `owner_artifact_version_id` | Indexed exact owner version copied from the record. |
| `dependency_artifact_id` | Indexed exact external artifact address. |
| `dependency_artifact_version_id` | Exact external occurrence used by derivation. |
| `dependency_role` | Registered namespaced explanation of how the artifact affects the record. |
| `producer_id` | Registered plugin or core component responsible for the dependency. |
| `producer_version` | Exact producer version. |
| `valid_from_generation` | First generation containing the owning record. |
| `valid_to_generation` | First generation not containing it; absent while the record remains current. |

Every `RecordArtifactDependencyDigestEntry` field has exactly the same type and value as its namesake on `RecordArtifactDependency`. The entry is a closed immutable digest-input value, not another stored dependency occurrence. Its absence of `dependency_entry_id` and `valid_to_generation` is normative; neither value can affect `artifact_dependency_digest`.

Logical storage must support efficient lookups equivalent to:

```text
(workspace_id, owner_artifact_id, valid_to_generation)
(workspace_id, dependency_artifact_id, valid_to_generation, record_id)
(workspace_id, normalized_path)
```

## Cross-spec model shapes already established

This section records models introduced while designing adjacent areas. Their presence here provides a complete data-model inventory; detailed behavior remains owned by the linked decision specifications.

### Control-plane source context

The workspace hierarchy uses the following approved control models:

```text
Codebase
  codebase_id
  display_name
  vcs_identity?
  created_at
  removed_at?

Workspace
  workspace_id
  codebase_id?
  canonical_root
  display_root
  source_provider_bindings[]
  current_snapshot_id?
  status
  vcs_state?
  registered_at
  relocated_at?
  suspended_at?
  removed_at?

WorkspaceSourceProviderBinding
  source_provider_binding_id
  source_provider
  source_provider_version
  provider_role
  binding_identity
  configuration_digest

WorkspaceConfigurationRevision
  configuration_revision_id
  schema_version
  workspace_id
  parent_configuration_revision_id?
  effective_configuration_schema_id
  effective_configuration_schema_version
  effective_configuration
  installation_policy_digest
  user_policy_digest
  workspace_file_digest?
  administrative_override_digest?
  analysis_configuration_digest
  query_configuration_digest
  resolved_embedding_binding_digests[]
  created_at
  reason_code
  revision_digest

VcsState
  provider
  common_repository_id?
  head_revision?
  ref_kind?
  ref_name?
  detached
  dirty
  captured_at

WorkspaceCurrentState
  workspace_id
  current_snapshot_id
  current_generation
  current_registry_snapshot_id
  current_resolution_lock_id
  current_configuration_revision_id
  current_freshness_checkpoint_id
  state_revision
  updated_at

WorkspaceFreshnessCheckpoint
  freshness_checkpoint_id
  workspace_id
  snapshot_id
  source_state_digest
  provider_watermarks[]
  verification_status
  unavailable_artifact_ids[]
  verified_at
  checkpoint_digest

Snapshot
  snapshot_id
  workspace_id
  generation
  parent_snapshot_id?
  generation_manifest_id
  registry_snapshot_id
  resolution_lock_id
  configuration_revision_id
  source_state_digest
  source_observation_watermarks[]
  canonical_record_set_digest
  projection_set_digests[]
  capability_state_digest
  published_at
  snapshot_digest

ProviderWatermark
  source_provider_binding_id
  source_provider
  source_provider_version
  ordering_domain
  watermark_value
  watermark_digest

ProjectionSetDigestEntry
  projection_kind
  generator
  generator_version
  generator_configuration_digest
  projection_set_digest

SnapshotCapabilityStateEntry
  capability
  capability_contract_version
  provider_id
  provider_version
  status
  reason_codes[]
  affected_artifact_ids[]
  diagnostic_record_ids[]
```

`Codebase.codebase_id` is the random stable identity of one optional grouping; `display_name` is mutable presentation metadata and `vcs_identity` is an optional matching hint, never identity authority. `created_at` records registration and `removed_at` is the one-way group closure time. Removing a codebase never removes its workspaces.

`Workspace.workspace_id` is the random stable identity of one registration. `codebase_id` is optional grouping membership. `canonical_root` is the provider-normalized duplicate-detection root or canonical virtual URI; `display_root` is the user-facing location. `source_provider_bindings` is non-empty and has exactly one `primary` binding. `current_snapshot_id` is absent only before first publication or after payload removal. `status` is `registering`, `indexing`, `ready`, `degraded`, `suspended`, `removing`, or `removed`. `vcs_state` is optional metadata captured for VCS-aware providers. `registered_at` is immutable; `relocated_at` is the latest explicit relocation time; `suspended_at` is present exactly while suspended; `removed_at` is present exactly for removed state. A removed workspace never reopens.

`WorkspaceSourceProviderBinding.source_provider_binding_id` identifies one binding occurrence. `source_provider + source_provider_version` resolve the registered platform-neutral component. `provider_role` is `primary` or `auxiliary`; only the primary supplies the workspace root address space. `binding_identity` is the provider's immutable normalized binding coordinate and `configuration_digest` commits to all output-affecting provider options without exposing secrets.

`WorkspaceConfigurationRevision.configuration_revision_id` identifies one immutable effective workspace configuration. `schema_version` selects this closed occurrence schema. `workspace_id` is its sole workspace, and `parent_configuration_revision_id` is absent only initially. `effective_configuration_schema_id + effective_configuration_schema_version` select the exact closed Schema-IR contract for `effective_configuration`, which contains normalized source selection, provider options, locally approved plugin selection, analyzer options, semantic activation, retention, query defaults, and security restrictions without secret bytes or mutable environment references.

`installation_policy_digest`, `user_policy_digest`, optional `workspace_file_digest`, and optional `administrative_override_digest` identify the exact normalized layers used under the approved precedence rules; absence means that layer contributed no file or override. `analysis_configuration_digest` commits to the subset capable of changing canonical or derived indexing output. `query_configuration_digest` commits to defaults capable of changing normalized query behavior but never overrides request-explicit values. `resolved_embedding_binding_digests` is the complete canonical-order set of exact executable bindings active for new materializations.

`created_at` is immutable informational time. `reason_code` is the registered creation cause: initial registration, source-policy change, plugin selection, analyzer options, semantic activation, retention policy, query defaults, security restriction, migration, rollback, or repair. `revision_digest` commits to every preceding field except the occurrence ID and creation time. Revisions never mutate or reopen; changing any effective value creates another revision and, when indexing output changes, the candidate pipeline publishes it atomically with the next snapshot.

`VcsState.provider` is the registered VCS family. `common_repository_id` is an optional local matching fingerprint. `head_revision` is the exact resolved immutable revision when available. `ref_kind` is `branch`, `tag`, `other`, or absent; `ref_name` is present exactly with `ref_kind`. `detached` is true exactly when no symbolic working ref selects HEAD. `dirty` reports provider-observed deviation from the resolved revision and is false for immutable virtual references. `captured_at` is the observation time. None of these fields defines workspace or entity identity.

`Codebase` groups related workspaces optionally. `Workspace` identifies one concrete mutable source root. `source_provider_bindings` is non-empty, unique by both binding ID and `source_provider + source_provider_version`, and contains exactly one `primary` role; any remaining bindings are `auxiliary`. Each pair selects one exact registered runtime component with a compatible `source_provider` contract binding. A new observation must match one binding active under its candidate configuration. Adding, removing, or changing a binding is an explicit workspace configuration transition and never reinterprets retained observations. Git state enriches a workspace but never determines its identity.

`WorkspaceSourceProviderBinding.source_provider_binding_id` is the immutable identity of one uninterrupted workspace/provider association. `source_provider` and `source_provider_version` are exact runtime-component coordinates. `provider_role` is `primary` for the component that defines the workspace root address space or `auxiliary` for an additional source namespace. A closed or replaced association receives another binding ID if it later reappears; retained observations continue to resolve through their pinned registry and configuration history.

`WorkspaceCurrentState` is the one mutable current pointer per workspace. Snapshot, generation, registry, plugin lock, and configuration must agree. Candidate publication replaces that tuple by compare-and-swap on the base snapshot. Updating freshness alone changes the checkpoint and `state_revision`, not the knowledge generation. Queries selecting `current` read this row atomically and acquire a snapshot lease before execution.

Freshness checkpoints prevent duplicate events or identical rescans from creating empty generations. `verification_status` is `equivalent`, `changes_pending`, or `degraded`. Equivalent proves that observations through the provider watermarks still match the snapshot. Changes pending states that relevant observations await publication. Degraded preserves the last valid snapshot while naming unavailable artifacts. Query responses identify both snapshot and freshness checkpoint; strict reads may wait for equivalence.

A snapshot exists only after publication. Generations are unique, strictly increasing, and gapless within one workspace. Parent is the exact base and is absent only initially. The source-state digest covers visible artifacts, versions, and tombstones. Projection-set entries pin projection kind, generator, version, configuration, and digest. Observation watermarks state what publication incorporated; later equivalent checkpoints may advance freshness without mutating the snapshot. Snapshot, generation manifest, and current pointer become visible atomically.

`ProviderWatermark.source_provider_binding_id` selects the exact uninterrupted workspace/provider association whose progress is recorded. `source_provider + source_provider_version` select its exact registered component contract, `ordering_domain` is exact `Text` identifying the provider-local stream or scan domain, and `watermark_value` is opaque `Bytes` interpreted only by that exact provider contract. `watermark_digest` covers all five values so equality can be verified without assigning cross-provider ordering semantics.

`ProjectionSetDigestEntry` identifies one complete projection set through its registered kind, exact generator implementation and configuration, and deterministic set digest. Entries are unique by projection kind plus generator contract within a snapshot.

`SnapshotCapabilityStateEntry` is one immutable snapshot-wide coverage assertion for an exact capability provider. `capability` is the registered behavioral contract and `capability_contract_version` is its exact SemVer version. `provider_id + provider_version` identify the resolved plugin or core component whose output is assessed. `status` is `complete`, `partial`, `unknown`, or `unsupported`. `stale` is never persisted here; the query layer may derive it only by comparing a snapshot with its pinned freshness checkpoint. `reason_codes` is empty exactly for `complete` and otherwise non-empty. `affected_artifact_ids` is the complete known set and may be empty for a non-complete status only when the selected reason explicitly permits unenumerable scope. `diagnostic_record_ids` is the complete supporting source-diagnostic set and may be empty when the limitation has no exact affected source artifact. Entries are unique by `capability + provider_id + provider_version` and their complete ordered set is committed by `Snapshot.capability_state_digest`.

### SourceProvider

`SourceProvider` is a closed read-only interface rather than a persisted knowledge record. Every implementation exposes exactly these operations:

```text
SourceProvider
  component_id
  component_version
  describe(request) -> response
  enumerate(request) -> response
  read(request) -> response
  watch(request) -> response
  reconcile(request) -> response

SourceProviderRequestEnvelope
  protocol_version
  request_id
  request_digest
  call
  workspace_id
  source_provider_binding_id
  component_id
  component_version
  deadline_at
  cancellation_id
  resource_budget
  payload

SourceProviderResponseEnvelope
  protocol_version
  request_id
  request_digest
  call
  workspace_id
  source_provider_binding_id
  component_id
  component_version
  outcome
  payload?
  error?

SourceProviderResourceBudget
  max_duration_ms
  max_response_bytes
  max_observations
  max_watch_events

SourceProviderFeatureSet
  supports_watch
  supports_authoritative_delete_events
  supports_complete_enumeration
  supports_stable_reconciliation
  supports_virtual_artifacts
  case_behavior
  read_only

SourceProviderDescribeRequest
  binding_configuration_digest

SourceProviderDescribeResult
  provider_kind
  immutable_binding_identity
  features
  source_state_fingerprint

SourceProviderEnumerateRequest
  coverage_scopes[]
  previous_watermark?

SourceProviderEnumerateResult
  observation_batch
  watermark
  capture_start_fingerprint
  capture_end_fingerprint

SourceProviderReadRequest
  artifact_id
  normalized_uri
  observed_content_hash?
  observed_metadata_digest?
  provider_version_token

SourceProviderReadResult
  artifact_id
  provider_version_token
  content_bytes
  content_hash
  byte_length
  metadata_digest

SourceProviderWatchRequest
  after_watermark?
  coverage_scopes[]
  max_wait_ms

SourceProviderWatchResult
  events[]
  watermark

SourceProviderWatchEvent
  ordering_domain
  event_token?
  provider_sequence?
  event_class
  normalized_uri
  authority

SourceProviderReconcileRequest
  coverage_scopes[]
  previous_watermark?

SourceProviderReconcileResult
  observation_batch
  watermark
  capture_start_fingerprint
  capture_end_fingerprint
  stable

SourceProviderError
  error_code
  retryability
  detail_code?
```

`protocol_version` selects this closed envelope contract. `request_id` is the occurrence identity; `request_digest` commits to the complete request envelope except its occurrence identity, deadline, and cancellation identity. `call` is exactly `describe`, `enumerate`, `read`, `watch`, or `reconcile`. Workspace, binding, and component coordinates must equal the active `WorkspaceSourceProviderBinding` and its resolved build. `deadline_at`, `cancellation_id`, and `resource_budget` bound one call and never change source meaning. `payload` is exactly the request or successful result type selected by `call`.

The response repeats every correlation and binding field exactly. `outcome` is the closed union `success`, `source_changed`, `unavailable`, `deadline_exceeded`, `resource_exhausted`, `cancelled`, or `failed`. `payload` is required exactly for `success`; `error` is required for every non-success outcome. `SourceProviderError.error_code` is a registered bounded provider-protocol code, `retryability` is `retry_same`, `retry_after_reconcile`, or `not_retryable`, and `detail_code` is optional provider-owned bounded context that cannot alter core semantics.

`SourceProviderResourceBudget` supplies positive upper bounds for elapsed milliseconds, encoded response bytes, observations returned by one enumeration or reconciliation, and events returned by one watch poll. `SourceProviderFeatureSet` states support for each optional behavior; `case_behavior` is `sensitive`, `insensitive_preserving`, or `provider_defined`, and `read_only` states whether the underlying source can change even though Urdira itself never writes it.

`describe` proves the normalized provider kind, immutable binding identity, current feature set, and opaque source-state fingerprint for the exact binding configuration. `enumerate` and `reconcile` accept a non-empty deduplicated scope set and optional provider-local previous watermark. Their successful result embeds one complete validated `SourceObservationBatch`, returns the successor `ProviderWatermark`, and brackets capture with opaque fingerprints. `reconcile.stable` is true exactly when those fingerprints are equal and the batch can exercise the authority it declares. Only a stable result with `coverage_completeness = complete` and `deletion_authority = true`, or an individually authoritative delete event admitted by the registered feature contract, proves absence.

`read` addresses one already observed artifact and repeats its provider version token. A successful result returns exact bytes, their verified digest and length, analysis-relevant metadata digest, and the unchanged token. A token or fingerprint change before or after capture returns `source_changed` and no bytes. `watch` returns a bounded ordered list of hints after its optional watermark. Each event declares an event class, normalized URI, provider-local ordering values, and `authority` of `hint` or `authoritative_delete`; watch never proves any other absence.

The reserved initial component lineages are `core:directory_source_provider`, `core:git_worktree_source_provider`, and `core:git_reference_source_provider`. A lineage becomes activatable only when a concrete release supplies its exact platform-neutral `RuntimeComponentDefinition`, a verified compatible local `RuntimeComponentBuild`, and a `source_provider` contract binding. Detailed scheduling, reconciliation, recovery, and retry behavior is approved in the incremental-indexing specification.

## Approved generation lifecycle

Only successful atomic publication assigns a numeric generation. Work in progress uses an opaque `candidate_generation_id`; failed, cancelled, or stale candidates leave no generation gaps and no temporal interval references. A published generation transforms the visible set as:

```text
visible(new) = visible(base) - closed_record_ids + opened_record_ids
```

Unchanged records are implicit and remain open. Applying an already accepted manifest is idempotent or returns an already-published result; it can never duplicate openings or closures.

```text
GenerationChangeManifest
  generation_manifest_id
  workspace_id
  candidate_generation_id
  generation
  snapshot_id
  base_snapshot_id?
  registry_snapshot_id
  publication_kind
  published_at
  artifact_change_set
  record_open_set
  record_closure_set
  identity_assignment_set
  projection_change_sets[]
  manifest_digest

ChangeSetDescriptor
  change_set_id
  change_set_kind
  entry_schema_version
  comparator_id
  comparator_version
  entry_count
  content_digest

ProjectionChangeSetDescriptor extends ChangeSetDescriptor
  projection_kind
  generator
  generator_version

OrderedSetDescriptor
  descriptor_id
  element_type
  element_schema_version
  comparator_id
  comparator_version
  entry_count
  content_digest
```

`publication_kind` is `initial`, `incremental`, `full_reconciliation`, `configuration_reanalysis`, `registry_reanalysis`, or `recovery_replay`. Base snapshot is absent only initially. Change-set entries are stored separately, deterministically ordered, digest-covered, and pageable; physical partitions and storage references are not part of the logical model. Canonical change-set kinds are the closed core values `core:artifact_change`, `core:record_open`, `core:record_closure`, and `core:identity_assignment`. Derived change sets are selected by a registered `projection_kind`; plugins cannot introduce another generation-change entry category.

`OrderedSetDescriptor` identifies any separately stored, canonically ordered, pageable logical set used by candidate planning, published manifests, or query execution. `element_type` selects one closed logical entry model, `element_schema_version` selects its exact validation contract, and `comparator_id + comparator_version` select the exact retained `CanonicalComparatorDefinition` used for ordering. The comparator must be valid for the element schema. `entry_count` is exact, and `content_digest` covers the descriptor's type and comparator coordinates plus the complete ordered entries. It does not expose a physical partition or storage address.

Every `change_set_kind` has one exact registered entry schema. `ChangeSetDescriptor.comparator_id + comparator_version` explicitly select the canonical order for those entries and must equal the comparator allowed by that change-set contract. A projection descriptor inherits the same coordinates. A descriptor therefore remains independently interpretable even if registry defaults change later.

```text
RecordOpen
  record_id
  workspace_id
  owner_artifact_id
  owner_artifact_version_id
  category
  kind
  universal_kind
  valid_from_generation
  open_reason_code
  previous_record_id?
  cause_references[]

RecordClosure
  record_id
  workspace_id
  owner_artifact_id
  owner_artifact_version_id
  category
  kind
  universal_kind
  valid_to_generation
  closure_reason_code
  replacement_record_id?
  cause_references[]

IdentityAssignment
  identity_assignment_id
  workspace_id
  identity_type
  identity_id
  assignment_kind
  identity_key
  identity_key_digest
  record_id
  previous_record_id?
  owner_artifact_id
  owner_artifact_version_id
  assigned_at_generation
```

Open and closure entries materialize indexed workspace and artifact ownership so change inspection never needs to hydrate the record merely to locate its file. Direct predecessor and replacement links are reciprocal when present. Facts and evidence without continuous identity normally omit them. Entry generations must equal the manifest generation. A record opens once and closes at most once.

`IdentityAssignment.identity_type` is `entity`, `relation`, or `diagnostic`; `assignment_kind` is only `created` or `continued`. Created requires no active compatible identity and no previous record. Continued requires an active identity in the base snapshot and the exact previous record. A matching closed key still creates a new identity. Unchanged reused records have no assignment entry.

Initial opening reason codes include:

- `core:initial_index`
- `core:owner_artifact_created`
- `core:owner_artifact_updated`
- `core:owner_artifact_recreated`
- `core:owner_artifact_reincluded`
- `core:dependency_updated`
- `core:resolution_changed`
- `core:producer_changed`
- `core:schema_changed`
- `core:configuration_changed`
- `core:registry_changed`
- `core:reconciliation_corrected`

Initial closure reason codes are:

- `core:owner_artifact_updated`
- `core:owner_artifact_deleted`
- `core:owner_artifact_excluded`
- `core:dependency_updated`
- `core:dependency_deleted`
- `core:dependency_excluded`
- `core:resolution_changed`
- `core:producer_changed`
- `core:schema_changed`
- `core:configuration_changed`
- `core:registry_changed`
- `core:reconciliation_corrected`

Reason codes are mandatory, registered, namespaced, and discoverable. Published manifests forbid an `unknown` fallback. Canonical record reason catalogs never contain projection-only reasons. Cause references identify exact records, artifacts, artifact versions, tombstones, observations, configuration revisions, registry snapshots, reconciliation runs, or recovery events. If the core cannot justify a closure, publication fails.

### Candidate planning and concurrency

Candidate analysis may run concurrently, but publication is serialized per workspace. A candidate publishes only if its base snapshot, registry, and configuration are still current. Otherwise it becomes stale and its observations are replanned from the new current snapshot; automatic merging or rebasing is forbidden in the initial contract, even for apparently disjoint files.

```text
IndexCandidate
  candidate_generation_id
  workspace_id
  base_snapshot_id?
  base_generation?
  base_registry_snapshot_id?
  target_registry_snapshot_id
  base_configuration_revision_id?
  target_configuration_revision_id
  trigger_kind
  state
  work_manifest_id?
  source_observation_batch_ids[]
  retention_lease_id?
  candidate_materialization_id?
  candidate_digest?
  created_at
  analysis_started_at?
  ready_at?
  finished_at?
  published_snapshot_id?
  published_generation?
  generation_manifest_id?
  stale_against_snapshot_id?
  failure_code?
  issue_ids[]
```

`trigger_kind` is `initial`, `source_change`, `reconciliation`, `configuration_change`, `registry_change`, or `recovery`. State is exactly `queued`, `planning`, `analyzing`, `validating`, `projecting`, `ready`, `publishing`, `published`, `stale`, `failed`, or `cancelled`. The normal path is `queued -> planning -> analyzing -> validating -> projecting -> ready -> publishing -> published`. `failed` and `cancelled` may be entered from any non-terminal state before publication commit; `stale` may be entered from `planning` through pre-commit `publishing` when the frozen base tuple is no longer current. The four terminal states are `published`, `stale`, `failed`, and `cancelled`.

Base fields are absent only initially. `work_manifest_id` is absent in `queued` and may change only during `planning` by selecting a newly created immutable manifest; it is required and immutable before entering `analyzing`. During `analyzing`, every accepted delta passes its local schema, scope, reference, dependency, and completeness gate before dependent DAG work may observe its staged output. `validating` performs whole-candidate validation; `projecting` constructs and validates derived outputs.

Mutable private staging is not a `CandidateMaterialization`. `candidate_materialization_id` and `candidate_digest` are absent through `projecting`. The transition to `ready` seals exactly one immutable generation-neutral materialization, assigns its ID, computes `materialization_digest`, then assigns `candidate_digest` once. Both fields are required from `ready` onward. Published fields occur only for published state, stale target is required for stale, and failure code is required for failed. Terminal non-published states release the base lease and make private materialization collectible. A committed publication tuple is authoritative: recovery confirms `published` even if acknowledgement or cleanup failed.

```text
CandidateMaterialization
  candidate_materialization_id
  candidate_generation_id
  workspace_id
  base_snapshot_id?
  target_registry_snapshot_id
  target_configuration_revision_id
  work_manifest_id
  accepted_fact_delta_digests[]
  source_transition_template_set
  record_open_template_set
  record_closure_template_set
  identity_assignment_template_set
  projection_open_template_sets[]
  projection_closure_template_sets[]
  capability_state_entries[]
  source_observation_watermarks[]
  materialization_digest
  created_at

CandidateSourceTransitionTemplate
  artifact_change
  target_artifact_version_without_generation?
  target_artifact_tombstone_without_generation?

CandidateRecordOpenTemplate
  record_without_validity
  open_reason_code
  previous_record_id?
  cause_references[]

CandidateRecordClosureTemplate
  record_id
  workspace_id
  owner_artifact_id
  owner_artifact_version_id
  category
  kind
  universal_kind
  closure_reason_code
  replacement_record_id?
  cause_references[]

CandidateIdentityAssignmentTemplate
  identity_assignment_id
  workspace_id
  identity_type
  identity_id
  assignment_kind
  identity_key
  identity_key_digest
  record_id
  previous_record_id?
  owner_artifact_id
  owner_artifact_version_id

CandidateProjectionOpenTemplate
  projection

CandidateProjectionTemplate
  projection_record_id
  projection_kind
  projection_key
  workspace_id
  owner_artifact_id
  owner_artifact_version_id
  source_artifact_version_ids[]
  source_record_ids[]
  source_projection_record_ids[]
  generator
  generator_version
  generator_configuration_digest
  payload

CandidateProjectionClosureTemplate
  projection_record_id
  projection_kind
  projection_key
  workspace_id
  owner_artifact_id
  owner_artifact_version_id
  generator
  generator_version
  generator_configuration_digest
  change_reason_code
  replacement_projection_record_id?
  cause_references[]
```

Every template is a closed schema, not an open partial object. The artifact-version, tombstone, and canonical-record `without_*` values mean the exact corresponding approved final model with only these publication-bound fields removed: numeric generation, publication timestamp, snapshot ID, generation-manifest ID, new-generation validity endpoint, and any digest whose payload contains one of those values. `CandidateProjectionOpenTemplate.projection` is exactly `CandidateProjectionTemplate`; each field has the same type and semantic meaning as its namesake on `DerivedProjectionEnvelope`, while `created_from_snapshot_id`, both generation-validity fields, and `content_digest` are absent because publication supplies them. Candidate occurrence IDs are allocated before sealing and remain invisible. `materialization_digest` covers every semantic field above except its own value, `candidate_materialization_id`, and `created_at`; its ordered sets use registry-pinned element schemas and comparators.

```text
CandidateWorkManifest
  work_manifest_id
  supersedes_work_manifest_id?
  workspace_id
  candidate_generation_id
  base_snapshot_id?
  artifact_work_set
  projection_work_set
  invalidation_plan_id
  target_registry_snapshot_id
  target_configuration_revision_id
  created_at
  work_digest

ArtifactWorkItem
  work_item_id
  workspace_id
  artifact_id
  base_artifact_version_id?
  base_tombstone_id?
  target_artifact_version_id?
  target_tombstone_id?
  operation
  plugin_id
  plugin_version
  capabilities[]
  expected_replacement_scopes[]
  reason_codes[]
  cause_references[]
  analysis_context_digest
  work_item_digest

ProjectionWorkItem
  projection_work_item_id
  workspace_id
  owner_artifact_id
  owner_artifact_version_id?
  target_tombstone_id?
  projection_kind
  operation
  generator
  generator_version
  generator_configuration_digest
  source_selection
  base_projection_set_digest
  reason_codes[]
  cause_references[]
  work_item_digest
```

The universal work manifest replaces the old plugin-upgrade-specific work manifest. `artifact_work_set` and `projection_work_set` are `OrderedSetDescriptor` values and remain pageable. Registry and configuration are frozen. A manifest is immutable. If planning discovers another dependency before analyzer execution, it creates a new manifest whose `supersedes_work_manifest_id` identifies the immediately preceding candidate manifest and atomically selects the new ID on `IndexCandidate`. Once the candidate enters `analyzing`, no manifest replacement or silent scope widening is permitted; newly discovered scope invalidates the attempt and replans from an appropriate base.

Artifact operation is `analyze` or `close`. Analyze covers create, update, recreate, reinclude, dependency invalidation, and context reanalysis; close covers delete, exclude, and plugin removal without invoking an analyzer. Work is plugin-specific and exact owner fields are indexed. Base and target version or tombstone combinations must agree with the artifact transition. A `FactDelta` must match its one work item exactly.

Projection operation is `rebuild` or `close`. `source_selection` is a closed registered selector evaluated over staged canonical candidate records. Rebuild produces a complete projection set for one owner artifact and kind. Close invokes no generator. Projection execution follows canonical validation and precedes atomic publication.

```text
InvalidationPlan
  invalidation_plan_id
  workspace_id
  candidate_generation_id
  base_snapshot_id?
  seed_change_set
  affected_artifact_set
  affected_record_set
  affected_projection_set
  dependency_index_digest
  maximum_scope
  fallback_scopes[]
  completeness
  created_at
  plan_digest
```

`seed_change_set`, `affected_artifact_set`, `affected_record_set`, and `affected_projection_set` are `OrderedSetDescriptor` values whose element types are respectively registered seed changes, `AffectedArtifactEntry`, `AffectedRecordEntry`, and `AffectedProjectionEntry`.

```text
InvalidationPathStep
  ordinal
  step_type
  from_reference
  to_reference
  dependency_role?
  reason_code

InvalidationNodeReference
  reference_type
  reference_id

AffectedArtifactEntry
  artifact_id
  artifact_version_id?
  required_operation
  cause_references[]
  invalidation_path[]

AffectedRecordEntry
  record_id
  owner_artifact_id
  owner_artifact_version_id
  required_operation
  cause_references[]
  invalidation_path[]

AffectedProjectionEntry
  projection_record_id
  projection_kind
  owner_artifact_id
  owner_artifact_version_id
  required_operation
  cause_references[]
  invalidation_path[]
```

- `InvalidationPathStep.ordinal` is zero-based and contiguous within one path. `step_type` is `seed`, `owner`, `artifact_dependency`, `record_reference`, `projection_source`, or `fallback_scope`.
- `from_reference` and `to_reference` are `InvalidationNodeReference` values. `reference_type` is `artifact`, `artifact_version`, `artifact_tombstone`, `record`, `projection`, `configuration_revision`, `registry_snapshot`, or `source_observation`, and `reference_id` must resolve to that exact type in the candidate workspace.
- `dependency_role` is required exactly for `artifact_dependency`; `reason_code` is a registered lifecycle or completeness reason appropriate to the step.
- Every `invalidation_path` is non-empty, begins at one declared seed, ends at the affected entry, and is complete enough to reproduce why that entry is included.
- `AffectedArtifactEntry.required_operation` is `analyze` or `close`; `AffectedRecordEntry.required_operation` is `recompute` or `close`; and `AffectedProjectionEntry.required_operation` is `rebuild` or `close`.

Every affected-set entry retains its exact cause and dependency path. `maximum_scope` is `targeted`, `plugin`, or `workspace`. Completeness must be `complete` before the definitive work manifest runs. Semantic indexes such as a call graph may report partial coverage while invalidation remains correct: plugins must emit conservative external dependencies, and any dependency that cannot be enumerated broadens invalidation to a registered plugin or workspace scope.

```text
CandidateIssue
  candidate_issue_id
  candidate_generation_id
  issue_code
  phase
  severity
  scope
  retryability
  summary
  detail?
  cause_references[]
  payload
  created_at

CandidateIssueCodeDefinition
  issue_code
  definition_revision
  schema_version
  description
  allowed_phases[]
  default_severity
  allowed_severities[]
  default_retryability
  allowed_retryabilities[]
  payload_schema
  plugin_owner?
  lifecycle_state
  deprecated_since?
  retired_since?
  replacement_issue_code?
```

```text
CandidateIssueScope =
  WorkspaceCandidateIssueScope |
  ArtifactCandidateIssueScope |
  WorkItemCandidateIssueScope |
  FactDeltaCandidateIssueScope |
  ReplacementScopeCandidateIssueScope |
  ProposalCandidateIssueScope |
  ProjectionCandidateIssueScope

WorkspaceCandidateIssueScope
  scope_type = workspace
  workspace_id

ArtifactCandidateIssueScope
  scope_type = artifact
  artifact_id
  artifact_version_id?

WorkItemCandidateIssueScope
  scope_type = work_item
  work_item_type
  work_item_id

FactDeltaCandidateIssueScope
  scope_type = fact_delta
  fact_delta_id

ReplacementScopeCandidateIssueScope
  scope_type = replacement_scope
  fact_delta_id
  replacement_scope_id

ProposalCandidateIssueScope
  scope_type = proposal
  fact_delta_id
  proposal_record_key

ProjectionCandidateIssueScope
  scope_type = projection
  projection_work_item_id
  projection_record_id?
```

`CandidateIssue.scope` is exactly one union member. Every nested identifier must belong to the issue's `candidate_generation_id` and workspace. `work_item_type` is `artifact` or `projection`; a projection record is optional because generation may fail before an occurrence is materialized. The selected issue definition restricts which scope types and optional identifiers are legal for that code.

Candidate issues are control-plane records, not source-owned knowledge diagnostics. Phase is `planning`, `analysis`, `validation`, `projection`, `publication`, or `cleanup`; severity is `warning` or `error`; retryability is `retry_same`, `replan`, `reanalyze`, or `not_retryable`. Scope is a typed workspace, artifact, work item, delta, replacement scope, proposal, or projection reference. Codes have registered closed payload schemas.

`CandidateIssueCodeDefinition` is the registration contract for core and plugin issue codes. `issue_code` is a stable namespaced identifier and `description` defines its exact trigger, interpretation, and non-meaning. `definition_revision` and `schema_version` follow the common registry rules. Allowed phases, severities, and retryabilities are non-empty closed sets containing their respective defaults. `payload_schema` is a closed typed schema that documents required fields, optional fields, value constraints, and forbids undeclared properties. `plugin_owner` and lifecycle fields follow the common typed-registry ownership and retirement rules. Namespace ownership and duplicate definitions are validated during plugin activation.

The initial issue-code catalog is:

| Phase | Codes |
|---|---|
| Planning | `core:invalidation_plan_incomplete`, `core:work_manifest_inconsistent`, `core:source_observation_conflict`, `core:source_input_unavailable`, `core:analysis_context_unavailable` |
| Analysis | `core:analyzer_failed`, `core:analyzer_timeout`, `core:plugin_inputs_incomplete`, `core:plugin_unsupported`, `core:plugin_cancelled`, `core:plugin_resource_exhausted`, `core:plugin_failed`, `core:required_delta_missing`, `core:delta_id_conflict` |
| Validation | `core:delta_base_mismatch`, `core:delta_scope_mismatch`, `core:undeclared_input`, `core:record_schema_invalid`, `core:unregistered_identifier`, `core:reference_validation_failed`, `core:dependency_validation_failed`, `core:replacement_scope_incomplete`, `core:identity_assignment_conflict`, `core:candidate_digest_mismatch` |
| Projection | `core:projection_generator_failed`, `core:projection_output_invalid`, `core:projection_digest_mismatch` |
| Publication and lifecycle | `core:candidate_digest_mismatch`, `core:base_snapshot_changed`, `core:base_registry_changed`, `core:base_configuration_changed`, `core:publication_conflict`, `core:atomic_publication_failed`, `core:candidate_cleanup_failed` |

`core:candidate_digest_mismatch` is legal in `validation` while sealing or recovering a ready materialization and in `publication` during pre-transaction verification. The five `core:plugin_*` outcome codes are likewise call-phase constrained across planning, analysis, and projection; their authoritative definitions enumerate the legal mapping. The three base-change codes produce `stale`, not `failed`. Cleanup failure may occur after successful publication without invalidating the snapshot. There is no unknown catch-all. Each code definition must document allowed phase, severity, retryability, required payload fields, optional payload fields, and exact trigger.

The normative initial definitions and payload schemas are published in the [core candidate issue-code registry](../indexing/core-candidate-issue-codes.md).

### Retention and physical garbage collection

Logical closure is immediate at publication; physical deletion is reachability-based. Roots are current snapshots, configured or manual pins, every workspace binding of an active query execution including comparisons, active indexing candidates, recovery operations, and recovery checkpoints. Canonical records, artifact versions, tombstones, registry state, projections, query manifests, evidence, and content blobs remain together while reachable. Derived projections required by an advertised retained snapshot remain available with their original generator and configuration; the system never silently rebuilds historical semantics using a newer generator.

```text
RetentionLease
  retention_lease_id
  workspace_id
  snapshot_id
  holder_type
  holder_id
  acquired_at
  last_renewed_at
  idle_expires_at?
  absolute_expires_at?
  released_at?
  release_reason?

SnapshotRetentionPin
  retention_pin_id
  workspace_id
  snapshot_id
  pin_kind
  reason_code
  source_reference?
  created_at
  expires_at?
  released_at?
  release_reason?
```

Lease holder type is `query_execution`, `index_candidate`, `recovery_operation`, or `administrative`. Acquisition is atomic with snapshot availability. A query execution has one lease per `WorkspaceSnapshotBinding`; single-workspace and comparison queries use the same holder type and lifecycle. Renewal may extend idle expiry but never absolute expiry. Release is one-way and idempotent. All cursor streams of one query execution share its complete lease set. Internal leases may omit wall-clock expiry only when their owning lifecycle guarantees release.

Pin kind is `policy`, `manual`, or `recovery_checkpoint`. The current snapshot is already a root and needs no synthetic pin. Multiple pins and leases may protect the same snapshot; collection requires all to end. Long-lived manual pins may omit expiry and require explicit release. Reason codes are registered and discoverable.

```text
SnapshotExpirationMarker
  snapshot_expiration_id
  workspace_id
  snapshot_id
  generation
  expired_at
  expiration_reason_code
  garbage_collection_epoch_id
  snapshot_digest

SnapshotRetentionStatus
  workspace_id
  snapshot_id
  generation
  availability
  is_current
  active_pin_count
  active_lease_count
  retention_reasons[]
  earliest_expiration_at?
```

Snapshot records remain immutable. Collection creates an expiration marker in the same operation that makes data inaccessible. Markers retain only identity, generation, digest, GC epoch, and cause; they never retain code or snippets. `availability` is `available` or `expired`, while current, pin, and lease reasons remain independent. Earliest expiration is informational.

Any `GarbageCollectionEpoch` referenced by a permanent `SnapshotExpirationMarker` retains a permanent minimal header containing its epoch ID, terminal state, start and completion times, retention-root digest, and deleted-object digest. Bulk candidate lists and workspace boundaries may be collected after the epoch is terminal, but the marker's reference never dangles.

The protocol distinguishes `core:cursor_expired`, `core:snapshot_expired`, and `core:snapshot_not_found`. A cursor never switches snapshots automatically. Expiration responses may explain how to repeat a query but never execute a replacement query implicitly. Minimal expiration catalog metadata remains available so known expiration differs from an identifier that never existed.

```text
GarbageCollectionEpoch
  garbage_collection_epoch_id
  state
  started_at
  mark_completed_at?
  sweep_started_at?
  completed_at?
  workspace_boundaries[]
  retention_root_digest
  candidate_object_count
  candidate_object_digest
  deleted_object_count?
  deleted_object_digest?
  failure_code?

WorkspaceGcBoundary
  workspace_id
  current_generation
  minimum_retained_generation
  evaluated_at
```

Mark captures roots and safe boundaries atomically with the lease-acquisition barrier. Unreachable objects become pending deletion, readers from earlier epochs drain, and sweep removes projections, canonical and source records, and finally globally unreferenced content blobs. Failures preserve a resumable idempotent epoch. `minimum_retained_generation` is a conservative optimization, never sufficient evidence by itself. TTL and age alone never authorize deletion. Open records, current artifact versions, and open tombstones are never collectible.

### Exact lifecycle field contracts

The following tables are normative field dictionaries for the lifecycle models above. Identifiers are immutable opaque identifiers unless a field explicitly states otherwise. All timestamps are UTC RFC 3339 values; ordering and identity never depend on wall-clock precision.

#### Source observation fields

| Model.field | Exact meaning |
|---|---|
| `SourceObservationBatch.observation_batch_id` | Immutable identity of one provider delivery, scan, or reconciliation batch. |
| `SourceObservationBatch.workspace_id` | Sole workspace whose source namespace the batch observes. |
| `SourceObservationBatch.source_provider_binding_id` | Exact uninterrupted workspace/provider association active under the candidate configuration. |
| `SourceObservationBatch.source_provider` | Registered runtime-component identity that produced the batch. |
| `SourceObservationBatch.source_provider_version` | Exact component version with a compatible `source_provider` contract binding governing event and coverage semantics. |
| `SourceObservationBatch.ordering_domain` | Exact provider-local stream or scan domain shared by every observation and cursor in the batch. |
| `SourceObservationBatch.observation_mode` | One of `event`, `scan`, or `reconciliation`. |
| `SourceObservationBatch.coverage_scopes` | Non-empty normalized scopes the provider attempted to observe. |
| `SourceObservationBatch.coverage_completeness` | `complete`, `partial`, or `failed` status of those scopes. |
| `SourceObservationBatch.deletion_authority` | Whether absence in a complete covered scope may confirm deletion. |
| `SourceObservationBatch.provider_cursor_before` | Optional opaque `Bytes` provider continuation immediately before this batch. |
| `SourceObservationBatch.provider_cursor_after` | Optional opaque `Bytes` provider continuation immediately after this batch. |
| `SourceObservationBatch.started_at` | Time observation began. |
| `SourceObservationBatch.completed_at` | Immutable completion time, not earlier than `started_at`; persisted batches are always complete occurrences even when `coverage_completeness` is `partial` or `failed`. |
| `SourceObservationBatch.observation_count` | Exact non-negative number of contained observations. |
| `SourceObservationBatch.unavailable_count` | Exact number of contained observations whose state is `unavailable`. |
| `SourceObservationBatch.batch_digest` | Digest of metadata and canonically ordered complete observation content. |
| `SourceObservation.source_observation_id` | Immutable identity of one normalized observation. |
| `SourceObservation.observation_batch_id` | Batch containing the observation. |
| `SourceObservation.workspace_id` | Workspace containing the observed artifact. |
| `SourceObservation.artifact_id` | Indexed exact artifact address observed. |
| `SourceObservation.source_provider_binding_id` | Exact provider association; must match the batch. |
| `SourceObservation.source_provider` | Registered runtime-component identity; must match the batch. |
| `SourceObservation.source_provider_version` | Exact component version; must match the batch and provide a compatible `source_provider` contract binding. |
| `SourceObservation.ordering_domain` | Exact provider-local ordering domain; must match the batch. |
| `SourceObservation.observation_mode` | Event, scan, or reconciliation mode; must match the batch. |
| `SourceObservation.observed_state` | `present`, `deleted`, or `unavailable`. |
| `SourceObservation.observed_content_hash` | Content hash supplied or computed for `present`; absent otherwise. |
| `SourceObservation.observed_metadata_digest` | Digest of provider metadata capable of changing analysis; optional when unavailable. |
| `SourceObservation.provider_event_token` | Optional provider-owned opaque `Bytes` deduplication token. |
| `SourceObservation.provider_sequence` | Optional non-negative `BigInteger` with provider-local order and no workspace-generation semantics. |
| `SourceObservation.observed_at` | Provider-declared observation time. |
| `SourceObservation.received_at` | Time Urdira accepted the observation. |
| `ObservationCoverageScope.scope_type` | `artifact`, `uri_prefix`, `source_root`, or `virtual_collection`. |
| `ObservationCoverageScope.source_provider_binding_id` | Exact provider association that owns the scope; it must match the containing batch. |
| `ObservationCoverageScope.source_provider` | Provider component that interprets the normalized scope key; it must match the containing batch and binding. |
| `ObservationCoverageScope.normalized_scope_key` | Canonical provider-specific key inside the batch workspace. |
| `ChangeCauseReference.cause_type` | Discriminator selecting an observation, artifact change, artifact, artifact version, tombstone, record, configuration revision, registry snapshot, reconciliation run, or recovery event. |
| `ChangeCauseReference.cause_id` | Exact identifier whose type must match `cause_type`. |

#### Artifact transition fields

| Model.field | Exact meaning |
|---|---|
| `ArtifactVersion.artifact_version_id` | Identity of one exact contiguous present-state version. |
| `ArtifactVersion.workspace_id` | Workspace whose generation interval governs the version. |
| `ArtifactVersion.artifact_id` | Indexed artifact address containing the version. |
| `ArtifactVersion.content_blob_id` | Immutable stored content referenced by this occurrence. |
| `ArtifactVersion.content_hash` | Digest of the exact raw source bytes, including BOM, encoding, line endings, and non-text bytes. |
| `ArtifactVersion.byte_length` | Exact raw content length in bytes. |
| `ArtifactVersion.encoding` | Canonical encoding label used to decode content. |
| `ArtifactVersion.language_hint` | Optional registered language hint; not proof that a plugin accepted the artifact. |
| `ArtifactVersion.analysis_metadata_digest` | Digest of non-content metadata capable of affecting analysis. |
| `ArtifactVersion.created_from_observation_id` | Authoritative observation that opened this version. |
| `ArtifactVersion.valid_from_generation` | First generation containing the version. |
| `ArtifactVersion.valid_to_generation` | First generation not containing it; absent while current. |
| `ArtifactChange.artifact_change_id` | Idempotent identity of one artifact-state transition in a candidate. |
| `ArtifactChange.workspace_id` | Workspace generation sequence containing the transition. |
| `ArtifactChange.artifact_id` | Indexed artifact address being transitioned. |
| `ArtifactChange.change_kind` | Closed transition discriminator from the approved transition table. |
| `ArtifactChange.previous_artifact_version_id` | Exact prior version when the transition starts from a present artifact. |
| `ArtifactChange.new_artifact_version_id` | Exact new version when the transition ends present. |
| `ArtifactChange.previous_tombstone_id` | Exact prior tombstone for recreation or reinclusion. |
| `ArtifactChange.new_tombstone_id` | Exact new tombstone for deletion or exclusion. |
| `ArtifactChange.cause_references` | Non-empty exact causes authorizing the transition. |
| `ArtifactChange.lineage_evidence_record_ids` | Optional evidence correlating separate artifact identities without changing them. |
| `ArtifactTombstone.artifact_tombstone_id` | Identity of one uninterrupted absence occurrence. |
| `ArtifactTombstone.workspace_id` | Workspace whose generation interval governs the absence. |
| `ArtifactTombstone.artifact_id` | Indexed absent or excluded artifact address. |
| `ArtifactTombstone.absence_kind` | `deleted` or `excluded`. |
| `ArtifactTombstone.absence_reason_code` | Registered exact machine-readable reason for the absence. |
| `ArtifactTombstone.last_artifact_version_id` | Last version visible immediately before absence. |
| `ArtifactTombstone.valid_from_generation` | First generation where the absence is visible. |
| `ArtifactTombstone.valid_to_generation` | First generation where the absence is no longer visible; absent while current. |
| `ArtifactTombstone.opening_artifact_change_id` | Transition that created the tombstone. |
| `ArtifactTombstone.closing_artifact_change_id` | Transition ending it; present exactly when closed. |
| `ArtifactTombstone.replacement_artifact_version_id` | Version opened by recreation or reinclusion; present exactly when closed. |
| `ArtifactTombstone.cause_references` | Exact observations or configuration causes supporting absence. |
| `ArtifactTombstone.lineage_evidence_record_ids` | Optional rename or recreation-correlation evidence. |

#### Generation-manifest fields

| Model.field | Exact meaning |
|---|---|
| `GenerationChangeManifest.generation_manifest_id` | Immutable identity of the complete published transition. |
| `GenerationChangeManifest.workspace_id` | Sole workspace transitioned. |
| `GenerationChangeManifest.candidate_generation_id` | Candidate whose validated materialization produced the transition. |
| `GenerationChangeManifest.generation` | Numeric generation assigned atomically at publication. |
| `GenerationChangeManifest.snapshot_id` | Snapshot created by applying the manifest. |
| `GenerationChangeManifest.base_snapshot_id` | Exact parent snapshot; absent only initially. |
| `GenerationChangeManifest.registry_snapshot_id` | Registry used to validate and interpret the new snapshot. |
| `GenerationChangeManifest.publication_kind` | Registered closed publication trigger category. |
| `GenerationChangeManifest.published_at` | Successful atomic publication time. |
| `GenerationChangeManifest.artifact_change_set` | Descriptor of all artifact transitions in the generation. |
| `GenerationChangeManifest.record_open_set` | Descriptor of all newly visible canonical records. |
| `GenerationChangeManifest.record_closure_set` | Descriptor of all canonical records becoming invisible. |
| `GenerationChangeManifest.identity_assignment_set` | Descriptor of identity allocations and continuations for opened records. |
| `GenerationChangeManifest.projection_change_sets` | Complete descriptors for opened and closed derived projections. |
| `GenerationChangeManifest.manifest_digest` | Digest of header and every referenced complete change set. |
| `ChangeSetDescriptor.change_set_id` | Immutable identity of one logical ordered change set. |
| `ChangeSetDescriptor.change_set_kind` | Registered identifier selecting the allowed entry schema and comparator family. |
| `ChangeSetDescriptor.entry_schema_version` | Exact version used to validate every entry. |
| `ChangeSetDescriptor.comparator_id` | Exact registered canonical comparator lineage used for the complete set. |
| `ChangeSetDescriptor.comparator_version` | Exact immutable ordering version used for the complete set. |
| `ChangeSetDescriptor.entry_count` | Exact total entries, independent of physical pages. |
| `ChangeSetDescriptor.content_digest` | Digest of the complete canonically ordered entry sequence. |
| `ProjectionChangeSetDescriptor.projection_kind` | Projection schema affected by the set. |
| `ProjectionChangeSetDescriptor.generator` | Registered generator identity shared by every entry. |
| `ProjectionChangeSetDescriptor.generator_version` | Exact generator version shared by every entry. |
| `RecordOpen.record_id` | Exact canonical record becoming visible. |
| `RecordOpen.workspace_id` | Indexed workspace copied from that record. |
| `RecordOpen.owner_artifact_id` | Indexed exact owner artifact copied from that record. |
| `RecordOpen.owner_artifact_version_id` | Indexed exact owner version copied from that record. |
| `RecordOpen.category` | Universal structural category used for filtering changes. |
| `RecordOpen.kind` | Concrete registered record kind. |
| `RecordOpen.universal_kind` | Registered core base kind. |
| `RecordOpen.valid_from_generation` | Opening generation, equal to the manifest generation. |
| `RecordOpen.open_reason_code` | Registered exact reason the record became visible. |
| `RecordOpen.previous_record_id` | Immediate prior record of the same continuous identity, when one exists. |
| `RecordOpen.cause_references` | Exact causal objects supporting the opening. |
| `RecordClosure.record_id` | Exact canonical record becoming invisible. |
| `RecordClosure.workspace_id` | Indexed workspace copied from the record. |
| `RecordClosure.owner_artifact_id` | Indexed exact owner artifact copied from the record. |
| `RecordClosure.owner_artifact_version_id` | Indexed exact owner version copied from the record. |
| `RecordClosure.category` | Universal structural category used for filtering changes. |
| `RecordClosure.kind` | Concrete registered record kind. |
| `RecordClosure.universal_kind` | Registered core base kind. |
| `RecordClosure.valid_to_generation` | Closing generation, equal to the manifest generation. |
| `RecordClosure.closure_reason_code` | Registered exact reason the record ceased to be visible. |
| `RecordClosure.replacement_record_id` | Direct replacement, absent for final removal or non-direct correspondence. |
| `RecordClosure.cause_references` | Exact causal objects justifying the closure. |
| `IdentityAssignment.identity_assignment_id` | Idempotent identity of one assignment decision. |
| `IdentityAssignment.workspace_id` | Workspace identity domain. |
| `IdentityAssignment.identity_type` | `entity`, `relation`, or `diagnostic`. |
| `IdentityAssignment.identity_id` | Core-assigned lifecycle identifier. |
| `IdentityAssignment.assignment_kind` | `created` or `continued`; reopening is invalid. |
| `IdentityAssignment.identity_key` | Canonical semantic, relation, or diagnostic matching key. |
| `IdentityAssignment.identity_key_digest` | Digest of that exact typed key. |
| `IdentityAssignment.record_id` | Opened canonical record receiving the identity. |
| `IdentityAssignment.previous_record_id` | Required exact active predecessor for `continued`; forbidden for `created`. |
| `IdentityAssignment.owner_artifact_id` | Indexed exact owner artifact. |
| `IdentityAssignment.owner_artifact_version_id` | Indexed exact owner version. |
| `IdentityAssignment.assigned_at_generation` | Manifest generation containing the assignment. |

#### Candidate and work-planning fields

| Model.field | Exact meaning |
|---|---|
| `IndexCandidate.candidate_generation_id` | Opaque identity of one unpublished generation attempt. |
| `IndexCandidate.workspace_id` | Sole workspace the candidate may publish into. |
| `IndexCandidate.base_snapshot_id` | Exact published base; absent only for initial indexing. |
| `IndexCandidate.base_generation` | Base snapshot generation; absent only initially. |
| `IndexCandidate.base_registry_snapshot_id` | Registry active at the base; absent only initially. |
| `IndexCandidate.target_registry_snapshot_id` | Registry the candidate output must satisfy. |
| `IndexCandidate.base_configuration_revision_id` | Analysis configuration at the base; absent only initially. |
| `IndexCandidate.target_configuration_revision_id` | Frozen configuration for candidate analysis. |
| `IndexCandidate.trigger_kind` | Initial, source, reconciliation, configuration, registry, or recovery trigger. |
| `IndexCandidate.state` | Current monotonic lifecycle state. |
| `IndexCandidate.work_manifest_id` | Selected immutable complete work manifest; absent only while queued or planning and immutable before analysis. |
| `IndexCandidate.source_observation_batch_ids` | Ordered deduplicated source batches coalesced into the candidate. |
| `IndexCandidate.retention_lease_id` | Lease protecting the base while active; absent only when no base exists or after release. |
| `IndexCandidate.candidate_materialization_id` | Private staged output identity, never a public snapshot. |
| `IndexCandidate.candidate_digest` | Final digest of frozen inputs, context, work, accepted deltas, and sealed materialization; absent through `projecting`, assigned once on entry to `ready`, and required thereafter. |
| `IndexCandidate.created_at` | Candidate creation time. |
| `IndexCandidate.analysis_started_at` | First analyzer-start time, once analysis begins. |
| `IndexCandidate.ready_at` | Time complete validation made the candidate publishable. |
| `IndexCandidate.finished_at` | Terminal-state time. |
| `IndexCandidate.published_snapshot_id` | Result snapshot, present exactly for published state. |
| `IndexCandidate.published_generation` | Assigned numeric generation, present exactly for published state. |
| `IndexCandidate.generation_manifest_id` | Published transition manifest, present exactly for published state. |
| `IndexCandidate.stale_against_snapshot_id` | New current snapshot that invalidated the base, required for stale state. |
| `IndexCandidate.failure_code` | Primary registered issue code, required for failed state. |
| `IndexCandidate.issue_ids` | Complete deterministic set of operational issues recorded for the attempt. |
| `CandidateWorkManifest.work_manifest_id` | Immutable identity of the exact work set. |
| `CandidateWorkManifest.supersedes_work_manifest_id` | Immediate earlier manifest for the same candidate replaced during planning; absent for the first manifest. |
| `CandidateWorkManifest.workspace_id` | Workspace containing every work item. |
| `CandidateWorkManifest.candidate_generation_id` | Candidate authorized to consume the manifest. |
| `CandidateWorkManifest.base_snapshot_id` | Exact planning base; absent only initially. |
| `CandidateWorkManifest.artifact_work_set` | Descriptor-backed complete ordered artifact work set. |
| `CandidateWorkManifest.projection_work_set` | Descriptor-backed complete ordered projection work set. |
| `CandidateWorkManifest.invalidation_plan_id` | Complete plan proving why the selected scope is sufficient. |
| `CandidateWorkManifest.target_registry_snapshot_id` | Frozen target registry. |
| `CandidateWorkManifest.target_configuration_revision_id` | Frozen target analysis configuration. |
| `CandidateWorkManifest.created_at` | Manifest creation time. |
| `CandidateWorkManifest.work_digest` | Digest of context and all canonically ordered work entries. |
| `ArtifactWorkItem.work_item_id` | Idempotent identity of one plugin/artifact task. |
| `ArtifactWorkItem.workspace_id` | Task workspace. |
| `ArtifactWorkItem.artifact_id` | Indexed exact owner artifact. |
| `ArtifactWorkItem.base_artifact_version_id` | Present base version when the base state is present. |
| `ArtifactWorkItem.base_tombstone_id` | Present base tombstone when the base state is absent. |
| `ArtifactWorkItem.target_artifact_version_id` | Target version when the candidate state is present. |
| `ArtifactWorkItem.target_tombstone_id` | Target tombstone when the candidate state is absent. |
| `ArtifactWorkItem.operation` | `analyze` or `close`. |
| `ArtifactWorkItem.plugin_id` | Registered logical plugin responsible for the task. |
| `ArtifactWorkItem.plugin_version` | Exact plugin version to run or whose prior output closes. |
| `ArtifactWorkItem.capabilities` | Complete registered capabilities exercised by the task. |
| `ArtifactWorkItem.expected_replacement_scopes` | Closed scopes the resulting delta must cover. |
| `ArtifactWorkItem.reason_codes` | Registered reasons the task is necessary. |
| `ArtifactWorkItem.cause_references` | Exact seed changes or invalidation paths causing the task. |
| `ArtifactWorkItem.analysis_context_digest` | Digest of registry, configuration, plugin dependencies, and relevant options. |
| `ArtifactWorkItem.work_item_digest` | Digest of every immutable task field. |
| `ProjectionWorkItem.projection_work_item_id` | Idempotent identity of one projection task. |
| `ProjectionWorkItem.workspace_id` | Task workspace. |
| `ProjectionWorkItem.owner_artifact_id` | Indexed exact projection owner. |
| `ProjectionWorkItem.owner_artifact_version_id` | Target owner version for rebuild; absent when closing an absent owner. |
| `ProjectionWorkItem.target_tombstone_id` | Target absence when closing due to deletion or exclusion. |
| `ProjectionWorkItem.projection_kind` | Registered projection schema to rebuild or close. |
| `ProjectionWorkItem.operation` | `rebuild` or `close`. |
| `ProjectionWorkItem.generator` | Registered runtime-component identity. |
| `ProjectionWorkItem.generator_version` | Exact component version with the `projection_generator` contract required by the projection kind. |
| `ProjectionWorkItem.generator_configuration_digest` | Digest of output-affecting generator configuration. |
| `ProjectionWorkItem.source_selection` | Registered closed selector over staged canonical candidate records. |
| `ProjectionWorkItem.base_projection_set_digest` | Digest of the visible base projection set being replaced. |
| `ProjectionWorkItem.reason_codes` | Registered reasons the task is necessary. |
| `ProjectionWorkItem.cause_references` | Exact canonical or control-plane causes. |
| `ProjectionWorkItem.work_item_digest` | Digest of every immutable projection-task field. |

#### Invalidation and candidate-issue fields

| Model.field | Exact meaning |
|---|---|
| `InvalidationPlan.invalidation_plan_id` | Immutable identity of one complete invalidation proof. |
| `InvalidationPlan.workspace_id` | Workspace whose base knowledge is traversed. |
| `InvalidationPlan.candidate_generation_id` | Candidate governed by the plan. |
| `InvalidationPlan.base_snapshot_id` | Exact traversal base; absent only initially. |
| `InvalidationPlan.seed_change_set` | Descriptor-backed exact initial artifact, configuration, or registry changes. |
| `InvalidationPlan.affected_artifact_set` | Complete affected artifact tasks with cause paths. |
| `InvalidationPlan.affected_record_set` | Complete current canonical records requiring close or recomputation. |
| `InvalidationPlan.affected_projection_set` | Complete current projections requiring close or rebuild. |
| `InvalidationPlan.dependency_index_digest` | Digest of the exact reverse dependency projection traversed. |
| `InvalidationPlan.maximum_scope` | Broadest applied scope: `targeted`, `plugin`, or `workspace`. |
| `InvalidationPlan.fallback_scopes` | Registered conservative scopes used where exact dependencies were unavailable. |
| `InvalidationPlan.completeness` | Must be `complete` for executable final work. |
| `InvalidationPlan.created_at` | Plan creation time. |
| `InvalidationPlan.plan_digest` | Digest of seeds, dependency base, paths, affected sets, and fallbacks. |
| `CandidateIssue.candidate_issue_id` | Immutable identity of one operational candidate issue. |
| `CandidateIssue.candidate_generation_id` | Candidate where the issue occurred. |
| `CandidateIssue.issue_code` | Registered machine-readable issue definition. |
| `CandidateIssue.phase` | Planning, analysis, validation, projection, publication, or cleanup phase. |
| `CandidateIssue.severity` | `warning` or `error`. |
| `CandidateIssue.scope` | Typed exact workspace, artifact, task, delta, scope, proposal, or projection location. |
| `CandidateIssue.retryability` | `retry_same`, `replan`, `reanalyze`, or `not_retryable`. |
| `CandidateIssue.summary` | Required bounded deterministic agent-readable explanation. |
| `CandidateIssue.detail` | Optional bounded explanation that cannot extend registered semantics. |
| `CandidateIssue.cause_references` | Exact causal objects relevant to diagnosis. |
| `CandidateIssue.payload` | Closed typed payload selected by `issue_code`. |
| `CandidateIssue.created_at` | Issue creation time. |
| `CandidateIssueCodeDefinition.issue_code` | Stable namespaced issue identifier owned by core or one activated plugin. |
| `CandidateIssueCodeDefinition.definition_revision` | Positive monotonic revision of the complete issue definition. |
| `CandidateIssueCodeDefinition.schema_version` | Positive monotonic version of the occurrence and payload validation contract. |
| `CandidateIssueCodeDefinition.description` | Normative exact trigger, meaning, and non-meaning of the code. |
| `CandidateIssueCodeDefinition.allowed_phases` | Non-empty closed phases where occurrences are legal. |
| `CandidateIssueCodeDefinition.default_severity` | Ordinary `warning` or `error` value. |
| `CandidateIssueCodeDefinition.allowed_severities` | Non-empty closed severity set containing the default. |
| `CandidateIssueCodeDefinition.default_retryability` | Ordinary retry action for the code. |
| `CandidateIssueCodeDefinition.allowed_retryabilities` | Non-empty closed retryability set containing the default. |
| `CandidateIssueCodeDefinition.payload_schema` | Closed schema validating every required and optional payload property. |
| `CandidateIssueCodeDefinition.plugin_owner` | Owning plugin ID for plugin codes; omitted for core codes. |
| `CandidateIssueCodeDefinition.lifecycle_state` | `active`, `deprecated`, or `retired`; retired definitions cannot produce new issues. |
| `CandidateIssueCodeDefinition.deprecated_since` | First discouraging definition revision, required for deprecated or retired definitions. |
| `CandidateIssueCodeDefinition.retired_since` | First definition revision forbidding new issues, required exactly for retired definitions. |
| `CandidateIssueCodeDefinition.replacement_issue_code` | Optional semantic successor for deprecated or retired codes; never an alias. |

#### Retention and garbage-collection fields

| Model.field | Exact meaning |
|---|---|
| `RetentionLease.retention_lease_id` | Identity of one renewable temporary retention root. |
| `RetentionLease.workspace_id` | Workspace owning the selected snapshot. |
| `RetentionLease.snapshot_id` | Exact protected snapshot. |
| `RetentionLease.holder_type` | Query execution, candidate, recovery, or administrative holder class; comparison participants use query-execution leases. |
| `RetentionLease.holder_id` | Exact owning execution or operation identifier. |
| `RetentionLease.acquired_at` | Successful atomic acquisition time. |
| `RetentionLease.last_renewed_at` | Most recent successful renewal time, initially equal to acquisition. |
| `RetentionLease.idle_expires_at` | Optional expiry if not renewed. |
| `RetentionLease.absolute_expires_at` | Optional non-extendable maximum lifetime. |
| `RetentionLease.released_at` | One-way explicit release time. |
| `RetentionLease.release_reason` | Registered reason for explicit or lifecycle-driven release. |
| `SnapshotRetentionPin.retention_pin_id` | Identity of one durable retention reason. |
| `SnapshotRetentionPin.workspace_id` | Workspace owning the snapshot. |
| `SnapshotRetentionPin.snapshot_id` | Exact protected snapshot. |
| `SnapshotRetentionPin.pin_kind` | `policy`, `manual`, or `recovery_checkpoint`. |
| `SnapshotRetentionPin.reason_code` | Registered reason the snapshot is pinned. |
| `SnapshotRetentionPin.source_reference` | Optional exact policy revision, request, or checkpoint that created the pin. |
| `SnapshotRetentionPin.created_at` | Pin creation time. |
| `SnapshotRetentionPin.expires_at` | Optional automatic expiry; absent for indefinite pins. |
| `SnapshotRetentionPin.released_at` | One-way explicit release time. |
| `SnapshotRetentionPin.release_reason` | Registered explicit-release reason. |
| `SnapshotExpirationMarker.snapshot_expiration_id` | Identity of the permanent minimal expiration record. |
| `SnapshotExpirationMarker.workspace_id` | Workspace that formerly contained the snapshot. |
| `SnapshotExpirationMarker.snapshot_id` | Exact expired snapshot. |
| `SnapshotExpirationMarker.generation` | Former generation of that snapshot. |
| `SnapshotExpirationMarker.expired_at` | Time payload availability ended. |
| `SnapshotExpirationMarker.expiration_reason_code` | Registered collection reason. |
| `SnapshotExpirationMarker.garbage_collection_epoch_id` | GC epoch that made the snapshot inaccessible. |
| `SnapshotExpirationMarker.snapshot_digest` | Original immutable digest retained for identification and audit. |
| `SnapshotRetentionStatus.workspace_id` | Workspace resolved by the status request. |
| `SnapshotRetentionStatus.snapshot_id` | Exact snapshot queried. |
| `SnapshotRetentionStatus.generation` | Snapshot generation. |
| `SnapshotRetentionStatus.availability` | `available` or `expired`. |
| `SnapshotRetentionStatus.is_current` | Whether it is the current workspace snapshot. |
| `SnapshotRetentionStatus.active_pin_count` | Exact current active pin count. |
| `SnapshotRetentionStatus.active_lease_count` | Exact current active lease count. |
| `SnapshotRetentionStatus.retention_reasons` | Deduplicated registered current root reasons. |
| `SnapshotRetentionStatus.earliest_expiration_at` | Optional informational earliest known root expiry. |

Garbage-collection epoch field contracts:

| Model.field | Exact meaning |
|---|---|
| `GarbageCollectionEpoch.garbage_collection_epoch_id` | Identity of one resumable mark-and-sweep attempt. |
| `GarbageCollectionEpoch.state` | Monotonic GC phase state. |
| `GarbageCollectionEpoch.started_at` | Epoch start time. |
| `GarbageCollectionEpoch.mark_completed_at` | Time root marking and candidate selection completed. |
| `GarbageCollectionEpoch.sweep_started_at` | Time physical deletion began after the reader barrier. |
| `GarbageCollectionEpoch.completed_at` | Successful terminal completion time. |
| `GarbageCollectionEpoch.workspace_boundaries` | Exact safe boundary evaluated for every participating workspace. |
| `GarbageCollectionEpoch.retention_root_digest` | Digest of the complete captured root set. |
| `GarbageCollectionEpoch.candidate_object_count` | Exact number of objects marked pending deletion. |
| `GarbageCollectionEpoch.candidate_object_digest` | Digest of the canonically ordered candidate identities. |
| `GarbageCollectionEpoch.deleted_object_count` | Exact objects physically deleted after sweep, present after sweep. |
| `GarbageCollectionEpoch.deleted_object_digest` | Digest of deleted identities, present after sweep. |
| `GarbageCollectionEpoch.failure_code` | Registered failure cause when the epoch has not completed successfully. |
| `WorkspaceGcBoundary.workspace_id` | Workspace evaluated during mark. |
| `WorkspaceGcBoundary.current_generation` | Current generation captured at the mark barrier. |
| `WorkspaceGcBoundary.minimum_retained_generation` | Conservative lowest generation reachable from workspace-local roots. |
| `WorkspaceGcBoundary.evaluated_at` | Boundary evaluation time. |

#### Workspace-state and snapshot fields

| Model.field | Exact meaning |
|---|---|
| `WorkspaceCurrentState.workspace_id` | Sole workspace whose current tuple is stored. |
| `WorkspaceCurrentState.current_snapshot_id` | Atomically selected current snapshot. |
| `WorkspaceCurrentState.current_generation` | Generation of the current snapshot. |
| `WorkspaceCurrentState.current_registry_snapshot_id` | Registry pinned by the current snapshot. |
| `WorkspaceCurrentState.current_resolution_lock_id` | Plugin resolution lock pinned by the current snapshot. |
| `WorkspaceCurrentState.current_configuration_revision_id` | Analysis configuration pinned by the current snapshot. |
| `WorkspaceCurrentState.current_freshness_checkpoint_id` | Latest freshness assessment of that snapshot. |
| `WorkspaceCurrentState.state_revision` | Monotonic control-plane revision, distinct from knowledge generation. |
| `WorkspaceCurrentState.updated_at` | Last current-tuple or freshness-pointer update time. |
| `WorkspaceFreshnessCheckpoint.freshness_checkpoint_id` | Immutable identity of one freshness assessment. |
| `WorkspaceFreshnessCheckpoint.workspace_id` | Assessed workspace. |
| `WorkspaceFreshnessCheckpoint.snapshot_id` | Snapshot whose source equivalence was assessed. |
| `WorkspaceFreshnessCheckpoint.source_state_digest` | Observed source-state digest compared with the snapshot. |
| `WorkspaceFreshnessCheckpoint.provider_watermarks` | Exact provider positions included in the assessment. |
| `WorkspaceFreshnessCheckpoint.verification_status` | `equivalent`, `changes_pending`, or `degraded`. |
| `WorkspaceFreshnessCheckpoint.unavailable_artifact_ids` | Exact known unavailable artifacts; empty unless degraded. |
| `WorkspaceFreshnessCheckpoint.verified_at` | Assessment completion time. |
| `WorkspaceFreshnessCheckpoint.checkpoint_digest` | UCE digest governed by `core:freshness_checkpoint_digest`; its positive field list is authoritative in the core digest-field registry. |
| `Snapshot.snapshot_id` | Immutable identity of one published workspace state. |
| `Snapshot.workspace_id` | Sole workspace represented. |
| `Snapshot.generation` | Unique gapless published generation. |
| `Snapshot.parent_snapshot_id` | Exact base snapshot; absent only initially. |
| `Snapshot.generation_manifest_id` | Manifest that produced the snapshot. |
| `Snapshot.registry_snapshot_id` | Exact definition registry required to interpret it. |
| `Snapshot.resolution_lock_id` | Exact plugin resolution used to produce it. |
| `Snapshot.configuration_revision_id` | Exact analysis configuration used to produce it. |
| `Snapshot.source_state_digest` | Digest of visible artifacts, versions, and tombstones. |
| `Snapshot.source_observation_watermarks` | Provider positions incorporated at publication. |
| `Snapshot.canonical_record_set_digest` | Digest of the complete visible canonical record set. |
| `Snapshot.projection_set_digests` | Per projection kind/generator/configuration visible-set digests. |
| `Snapshot.capability_state_digest` | Digest of snapshot-wide capability coverage and limitations. |
| `Snapshot.published_at` | Atomic publication time. |
| `Snapshot.snapshot_digest` | UCE digest governed by `core:snapshot_digest`; its positive field list and referenced set digests are authoritative in the core digest-field registry. |


### Approved relation model

Relations are typed, versioned, potentially n-ary canonical records. They are not limited to graph edges: a relation can have named participants, ordered arguments, literals, unresolved symbols, multiple dispatch candidates, its own evidence, and an independent lifecycle.

#### RelationRecord and temporal identity

```text
RelationRecord extends RecordEnvelope
  relation_id
  relation_key
  identity_stability
  arguments[]
  evidence_record_ids[]
  payload
```

- `record_id` identifies one immutable version of the relation record.
- `relation_id` identifies the logical relation across workspace generations.
- `relation_key` is the reproducible core-finalized matching key built from the plugin's `RelationIdentityInput` after candidate anchor identities resolve; plugins never emit it directly.
- `identity_stability` uses the same `stable`, `best_effort`, and `ephemeral` vocabulary as entities.
- `arguments` contains all semantic participants. Their roles, not array position, define meaning.
- `evidence_record_ids` cites evidence applying to the relation as a whole. An argument can cite more specific evidence.

The core-finalized reproducible relation key is based on:

```text
workspace_id + relation_kind + anchor_entity_id + local_relation_key
```

The anchor is the source construct that asserts the relation. A call uses its call-site entity, an import uses its import-declaration entity, inheritance uses its extends or implements clause, a return relation uses its declaration or return-site entity, and a data-flow relation uses the analyzer's flow-step entity.

Plugins cannot emit that finalized key because an anchor proposed in the same candidate does not yet have an `entity_id`. Instead, a relation proposal supplies:

```text
RelationIdentityInput
  relation_kind
  anchor_reference
  local_relation_key
  additional_identity_components[]
```

- `relation_kind` is the exact registered concrete relation kind and must equal the proposed record kind.
- `anchor_reference` is a `ProposedReference` constrained by the relation definition's `anchor_role` to resolve to exactly one entity.
- `local_relation_key` is the producer-stable discriminator for the asserting construct within that anchor.
- `additional_identity_components` is the canonically ordered closed set of plugin-defined identity components permitted by the concrete relation definition; it is empty when the universal identity is sufficient.

After resolving all candidate entity identities, the core replaces `anchor_reference` with the assigned `anchor_entity_id`, validates every additional component, and constructs the canonical `relation_key`. It then assigns `relation_id` through the same active-base mechanism used for entities. Plugins never receive or predict core-assigned identifiers merely to form a proposal identity.

Targets not declared as identity roles are deliberately excluded from the key. If type inference or name resolution changes such a target while the relation remains continuously present, Urdira creates a new `record_id` under the same `relation_id`. Changing or deleting the asserting anchor closes the relation. A closed `relation_id` is never reopened; a later relation with the same finalized key receives a new identifier.

#### RelationArgument and target union

```text
RelationArgument
  argument_id
  role
  position?
  target
  resolution_state
  confidence_level?
  evidence_record_ids[]

RelationTarget =
  EntityTarget |
  RecordTarget |
  ArtifactTarget |
  LiteralTarget |
  UnresolvedTarget

EntityTarget
  target_type = entity
  entity_id
  entity_record_id?

RecordTarget
  target_type = record
  record_id

ArtifactTarget
  target_type = artifact
  artifact_id
  artifact_version_id?

LiteralTarget
  target_type = literal
  value_type
  value

UnresolvedTarget
  target_type = unresolved
  symbol
  namespace?
  candidate_entity_ids[]
```

`target_type` is the required discriminator. `resolution_state` is `resolved`, `unresolved`, or `ambiguous`. `confidence_level` uses `high`, `medium`, or `low`; it is required when the argument's evidence classifies that target as possible and forbidden when the target is confirmed.

`entity_id` refers to a logical entity across generations; `entity_record_id`, when present, pins the exact entity version used by the analysis. `artifact_version_id` provides the equivalent optional pin for an artifact. A `RecordTarget` always points to an exact canonical record version.

`argument_id` is unique within one `RelationRecord` version and identifies an argument even when its role is unordered or appears more than once. `position` is required only for roles declared as ordered. Positions are zero-based, unique within one role, and explicit; serialization order never carries semantic meaning.

An `UnresolvedTarget` is retained as useful knowledge rather than dropping the relation. Its candidates are hints, not resolved participants. The producer emits `core:unresolved_symbol` when no target is confirmed and `core:ambiguous_target` when multiple competing candidates remain, subject to those registered codes' exact emission conditions. Later resolution creates a new version of the same `relation_id`.

#### Relation kind and role schemas

Every relation kind registers an additional schema:

```text
RelationKindDefinition
  kind
  roles[]
  identity_roles[]
  anchor_role?

RelationRoleDefinition
  name
  allowed_target_types[]
  allowed_universal_kinds[]
  required_target_facets[]
  min_count
  max_count?
  ordered
  identity_part
```

`roles` is a closed set unless a namespaced extension schema explicitly adds roles. `allowed_target_types` validates the target union discriminator. `allowed_universal_kinds` further restricts entity targets and is empty when the role accepts any entity kind or accepts no entity targets. `required_target_facets` lists facets every entity target must carry. `min_count` and `max_count` define cardinality; an absent `max_count` means unbounded. `identity_roles` identifies the roles used when deriving `relation_key`. `anchor_role`, when present, must select exactly one entity argument and that entity is the `anchor_entity_id` in the temporal identity formula. `identity_part` makes the same rule visible on each role definition and must agree with `identity_roles`.

`RelationKindDefinition` and `RelationRoleDefinition` are closed nested parts of their parent `RecordKindDefinition`, not independent global registries. `RelationKindDefinition.kind` must equal the parent kind. A role `name` is ASCII `snake_case` and unique only within that relation kind; its lifecycle, structural version, ownership, and compatibility are governed by the parent definition revision and schema version. Candidate issue identifier type `relation_role` therefore means a role name absent from the selected relation kind, not an unqualified global namespaced identifier.

The universal `core:call` relation is equivalent to:

```json
{
  "kind": "core:call",
  "identity_roles": ["call_site"],
  "anchor_role": "call_site",
  "roles": [
    {
      "name": "caller",
      "allowed_target_types": ["entity"],
      "allowed_universal_kinds": ["core:callable", "core:container"],
      "required_target_facets": [],
      "min_count": 1,
      "max_count": 1,
      "ordered": false,
      "identity_part": false
    },
    {
      "name": "call_site",
      "allowed_target_types": ["entity"],
      "allowed_universal_kinds": ["core:operation"],
      "required_target_facets": ["core:call_site"],
      "min_count": 1,
      "max_count": 1,
      "ordered": false,
      "identity_part": true
    },
    {
      "name": "target",
      "allowed_target_types": ["entity", "unresolved"],
      "allowed_universal_kinds": ["core:callable", "core:type", "core:resource"],
      "required_target_facets": [],
      "min_count": 1,
      "ordered": false,
      "identity_part": false
    },
    {
      "name": "argument",
      "allowed_target_types": ["entity", "literal"],
      "allowed_universal_kinds": ["core:value", "core:operation", "core:resource", "core:type"],
      "required_target_facets": [],
      "min_count": 0,
      "ordered": true,
      "identity_part": false
    }
  ]
}
```

Dynamic or overloaded dispatch is represented by one call relation with multiple `target` arguments. Each candidate carries its own `confidence` and `evidence_record_ids`. The graph projection may materialize one edge per target, but those edges remain views of one canonical relation.

#### Ownership and workspace constraints

- A canonical relation belongs to exactly one workspace.
- Every resolved entity or artifact target belongs to the same workspace as the relation.
- The mandatory `owner_artifact_id` identifies the artifact containing the asserting anchor, not the target definition.
- Every target artifact and every artifact used to resolve or validate the relation appears in `RecordArtifactDependency` with its exact version and dependency role.
- Role cardinality, allowed target types, ordering, and identity participation are validated against `RelationKindDefinition` before insertion.
- Canonical cross-workspace relations are forbidden. Explicit comparison queries may produce derived cross-workspace correlations, but these are not canonical knowledge records.

### FactRecord

The approved fact structure is:

```text
FactRecord extends RecordEnvelope
  subject_entity_id?
  subject_record_id?
  typed_value
  evidence_record_ids[]
  payload
```

Exactly one of `subject_entity_id` and `subject_record_id` is present. The concrete `kind` acts as the precise fact predicate, `universal_kind` selects one approved fact base, and that kind's closed schema validates `typed_value` and `payload`. The boundary between inline properties and facts is the approved rule defined under universal record categories.

### Approved evidence model

Evidence is a first-class canonical record rather than duplicated inline metadata. It can justify a whole record or one exact relation argument, be cited by multiple conclusions, depend on multiple source artifacts, and form a bounded derivation chain.

#### EvidenceRecord

```text
EvidenceRecord extends RecordEnvelope
  subjects[]
  basis
  derivation
  claim_class
  confidence_level?
  source_references[]
  supporting_record_ids[]
  supporting_evidence_record_ids[]
  assumption_codes[]
  explanation_code
  payload
```

- `subjects` is a non-empty set of exact conclusions or relation arguments justified by the evidence.
- `basis` identifies the analysis mechanism. Core values are `syntax`, `symbol_resolution`, `type_analysis`, `control_flow`, `data_flow`, `framework_model`, `configuration`, `vcs`, `semantic_similarity`, and `heuristic`.
- `derivation` is `direct`, `deterministic`, `modeled`, or `heuristic`. It distinguishes observation, rule-based derivation, model-dependent derivation, and fallible inference.
- `claim_class` is `confirmed` or `possible`. It states whether this evidence chain establishes the subject under its declared assumptions or only supports it as a candidate.
- `confidence_level` is `high`, `medium`, or `low`. It is required for `possible` evidence and forbidden for `confirmed` evidence. Urdira defines no canonical numeric confidence and does not compare private plugin scores.
- `source_references` identifies every exact source occurrence directly supporting the evidence. It may be empty only when all support comes from `supporting_record_ids` or `supporting_evidence_record_ids`.
- `supporting_record_ids` contains exact canonical record versions consumed by this derivation.
- `supporting_evidence_record_ids` contains earlier evidence records and permits a derivation DAG without requiring a formal proof graph for every extraction.
- `assumption_codes` contains stable, namespaced assumptions under which the claim holds. An empty set means the producer declares no additional assumptions beyond its registered capability contract.
- `explanation_code` is a required stable, namespaced machine-readable reason suitable for filtering, localization, and concise agent explanations.
- `payload` contains kind-specific details validated by the registered evidence-kind schema.

The producer fields inherited from `RecordEnvelope` identify the analyzer and version. Evidence has no separate temporal identity: it justifies exact record versions, and source or analysis changes produce a new evidence record.

#### Evidence subjects

```text
EvidenceSubject =
  RecordSubject |
  RelationArgumentSubject

RecordSubject
  subject_type = record
  record_id

RelationArgumentSubject
  subject_type = relation_argument
  relation_record_id
  argument_id
```

`subject_type` is the required discriminator. `record_id` and `relation_record_id` always identify immutable canonical record versions. `argument_id` is resolved within the selected relation version, so evidence can distinguish several unordered dispatch candidates carrying the same role.

#### Exact source references

```text
SourceReference
  artifact_id
  artifact_version_id
  span?
```

- `artifact_id` identifies the source artifact containing the supporting occurrence.
- `artifact_version_id` is mandatory and pins the exact content occurrence used by the analysis.
- `span` is an optional `SourceSpan` within that artifact version. Its absence means that the entire artifact or non-local artifact metadata supports the evidence.

The evidence record's mandatory owner artifact is its primary asserting source. Every additional source reference and every artifact transitively required by supporting records is registered through `RecordArtifactDependency`, enabling reverse invalidation by file.

#### Classification and confidence aggregation

Agent-facing results are divided into `confirmed` and `possible` result streams. Ambiguous candidates are never hidden and never mixed with established relations.

- A result is `confirmed` only when at least one complete supporting chain is confirmed and every declared assumption is satisfied.
- Otherwise, a supported result is `possible`.
- A possible chain receives the weakest confidence level in that chain.
- With several independent chains, ranking uses the strongest chain, but Urdira does not automatically increase confidence merely because several heuristic chains agree.
- Heuristic evidence cannot become confirmed by accumulation.
- Modeled evidence may be confirmed only relative to an identified model version and explicit assumptions.
- Conflicting conclusions and their evidence remain visible; Urdira does not average or discard them.

Using `low < medium < high`, aggregation is equivalent to:

```text
possible_chain_confidence = minimum(confidence levels of possible evidence in the chain)
possible_result_confidence = maximum(supporting chain confidences)
```

Confirmed evidence in an otherwise possible chain is confidence-neutral because it has no `confidence_level`. The minimum is taken only over the non-empty set of possible evidence records in that chain. A chain containing no possible evidence is a confirmed chain and is not assigned a confidence level.

`confirmed` is a classification outside the confidence scale.

#### Completeness model

Completeness measures coverage, not certainty. A complete query may contain possible results when Urdira knows that it found the entire candidate set but cannot resolve every candidate uniquely.

```text
CompletenessReport
  workspace_snapshot_binding_ids[]
  overall_status
  dimensions[]
  diagnostic_record_ids[]

CompletenessDimension
  workspace_snapshot_binding_ids[]
  capability
  status
  reason_codes[]
  affected_artifact_count?
  affected_artifact_ids[]
  affected_artifact_set_id?
  diagnostic_record_ids[]
```

`CompletenessReport` fields:

- `workspace_snapshot_binding_ids` is the non-empty deterministically ordered set of exact query bindings evaluated by the complete logical query, including every paginated result stream. It contains one binding for an ordinary query and every participant for an explicit comparison.
- `overall_status` is the engine-computed worst relevant status after evaluating all capabilities required by the query. Plugins cannot set it directly.
- `dimensions` is a non-empty list describing coverage for relevant capabilities such as source discovery, parsing, symbol resolution, call graph, data flow, dependencies, and framework models.
- `diagnostic_record_ids` is the deduplicated set of diagnostics that materially affect the overall result. Empty means that no diagnostic reduces or qualifies coverage.

`CompletenessDimension` fields:

- `workspace_snapshot_binding_ids` is the non-empty subset of execution bindings to which this coverage statement applies. Separate dimensions preserve different statuses for the same capability in different workspaces.
- `capability` is the stable, namespaced capability whose coverage is being reported.
- `status` is `complete`, `partial`, `unknown`, `unsupported`, or `stale`.
- `reason_codes` contains stable, namespaced machine-readable explanations for any non-complete status.
- `affected_artifact_count` is present when the complete affected artifact set is enumerable and gives its exact cardinality; it is omitted when the scope cannot be enumerated.
- `affected_artifact_ids` is a deterministic inline prefix of the enumerable affected set bounded by the response budget. It contains the complete set when its length equals `affected_artifact_count` and is empty when enumeration is impossible.
- `affected_artifact_set_id` is required exactly when an enumerable set does not fit inline. It identifies an immutable query-execution-scoped set with bidirectional cursor pagination and is omitted otherwise.
- `diagnostic_record_ids` cites the exact diagnostics supporting this dimension's status.

Status semantics are:

- `complete`: coverage is guaranteed for the declared query scope and registered analysis model.
- `partial`: known coverage gaps exist.
- `unknown`: Urdira cannot establish the coverage achieved.
- `unsupported`: a required capability is unavailable and no accepted fallback supplies it.
- `stale`: the snapshot does not represent the latest source state already observed for the workspace.

For a single overall value, severity precedence is `unsupported`, `stale`, `unknown`, `partial`, then `complete`. Detailed dimensions are always retained so the scalar does not hide independent limitations.

Completeness belongs to the full snapshot-pinned query execution, not an individual page. Remaining pages do not make a query partial, and every page or evidence cursor from the same execution reports the same completeness semantics.

Ranking-feature availability follows the same execution-wide rule. A feature requiring incomplete knowledge is omitted uniformly from its complete ranked result set when partial execution is permitted, and the causative capability dimensions remain in `CompletenessReport`. It is never evaluated only for covered candidates or assigned a silent zero for unknown candidates. The execution pins the active and omitted feature sets; later capability progress cannot alter its manifest or continuation pages.

#### Agent-facing evidence views

The public API exposes a bounded assessment rather than forcing agents to hydrate canonical evidence records individually:

```text
ResultAssessment
  classification
  confidence_level?
  evidence_summary?
  completeness

EvidenceSummary
  primary_basis
  primary_derivation
  explanation_code
  evidence_count
  assumption_codes[]
  citations[]
  has_more_evidence
  evidence_cursor?

EvidenceCitation
  evidence_record_id
  basis
  derivation
  claim_class
  confidence_level?
  explanation_code
  source

SourceReferenceView
  artifact_id
  artifact_version_id
  path
  span?
  snippet?

SourceSnippet
  text
  span
  truncated
  redacted
  redactions[]

SnippetRedaction
  source_span
  output_start_character
  output_end_character
  reason_code
```

`ResultAssessment` fields:

- `classification` is required and is exactly `confirmed` or `possible`.
- `confidence_level` is required only for `possible` and forbidden for `confirmed`. Its values are the ordered non-numeric tiers `high`, `medium`, and `low`; possible-result streams partition by that order before applying relevance ranking within a tier. Confidence is never converted into or modified by a ranking score.
- `evidence_summary` is always present unless the request explicitly sets evidence inclusion to `none`.
- `completeness` is the `complete`, `partial`, `unknown`, `unsupported`, or `stale` status relevant to the stages that produced this result. The page-level `CompletenessReport` provides dimension details without repeating them in every bundle.

`EvidenceSummary` fields:

- `primary_basis` is the basis of the strongest selected supporting chain.
- `primary_derivation` is the derivation class of that chain's decisive evidence.
- `explanation_code` is the stable reason best summarizing why the result was returned.
- `evidence_count` is the total number of directly associated evidence records, including records not hydrated into `citations`.
- `assumption_codes` is the deduplicated set of assumptions applying to the selected chain.
- `citations` contains the evidence citations that fit the requested inclusion mode and response budget.
- `has_more_evidence` is true exactly when more directly associated evidence exists beyond `citations`.
- `evidence_cursor` is present exactly when `has_more_evidence` is true and continues the snapshot-pinned evidence stream without rerunning the parent query.

`EvidenceCitation` fields:

- `evidence_record_id` identifies the exact canonical evidence record represented by the citation.
- `basis`, `derivation`, `claim_class`, and `confidence_level` retain the canonical meanings and presence rules defined above.
- `explanation_code` retains the canonical stable reason without replacing it with free-form prose.
- `source` is the primary `SourceReferenceView` for this citation. Additional supporting sources are available through evidence pagination when requested.

`SourceReferenceView` fields:

- `artifact_id` identifies the source artifact.
- `artifact_version_id` pins the exact source content used to render the response.
- `path` is always present. It is the normalized workspace-relative path for a physical artifact and the canonical source URI for a virtual artifact.
- `span` is the exact optional `SourceSpan` within the artifact version.
- `snippet` is present only when requested and permitted by the response budget.

`SourceSnippet` fields:

- `text` is the selected source text from the pinned artifact version, with fixed markers substituted only when `redacted` is true.
- `span` identifies the exact half-open source byte range selected before permitted redaction.
- `truncated` is true when source outside `span` was omitted by the requested projection or response budget.
- `redacted` is true exactly when one or more source substrings were replaced under security policy.
- `redactions` is empty exactly when `redacted` is false and otherwise contains every replacement in source order.

`SnippetRedaction.source_span` is the exact source byte range replaced. `output_start_character` and `output_end_character` are zero-based half-open Unicode-scalar offsets locating the fixed marker in returned `text`. `reason_code` is the registered security-policy cause and never contains the removed value.

#### Evidence request controls

```text
EvidenceIncludeOptions
  evidence
  evidence_chain_depth

SourceIncludeOptions
  mode
  max_characters_per_snippet
  max_total_characters
  context_lines
```

- `evidence` is `none`, `summary`, or `full`; it defaults to `summary`. `none` omits `EvidenceSummary` but never omits classification or completeness.
- `evidence_chain_depth` is a non-negative integer limiting recursive supporting-evidence expansion. It defaults to `1`; `0` returns direct citations without their supporting chains.

`SourceIncludeOptions.mode` is `none`, `signature`, `relevant`, or `body` and defaults to `none`. `signature` selects the exact registered declaration-signature span when available; `relevant` selects operation-defined evidence spans; `body` selects the smallest containing declaration or artifact region permitted by the operation. `max_characters_per_snippet` and `max_total_characters` are non-negative server-bounded UTF-8 character budgets and must both be zero exactly when mode is `none`. `context_lines` is a non-negative server-bounded number of surrounding presentation lines applied only to `relevant`; it is zero for other modes. Security policy may redact or omit content but cannot widen the requested projection.

Full evidence remains bounded by the response budget. When it cannot fit, Urdira returns complete result bundles with `has_more_evidence` and a dedicated evidence cursor. Confirmed and possible results maintain independent counts and cursor-addressable streams so one group cannot conceal the existence of the other.

### Approved diagnostic model

Diagnostics are versioned, source-owned knowledge about limitations or conditions affecting an indexed snapshot. They are distinct from protocol and service failures: a `DiagnosticRecord` may qualify knowledge and completeness, while an `OperationError` rejects or interrupts an operation.

#### DiagnosticRecord

```text
DiagnosticRecord extends RecordEnvelope
  diagnostic_id
  diagnostic_key
  diagnostic_code
  diagnostic_category
  severity
  completeness_effect
  completeness_status?
  affected_scopes[]
  recoverability
  summary
  detail?
  evidence_record_ids[]
  payload
```

- `diagnostic_id` identifies the logical diagnostic across workspace generations.
- `diagnostic_key` is the reproducible producer key used to recover that logical identity after re-analysis.
- `diagnostic_code` is a stable, namespaced code registered through `DiagnosticCodeDefinition`. An unregistered code cannot be inserted.
- `diagnostic_category` is one universal category: `source`, `syntax`, `resolution`, `type_analysis`, `control_flow`, `data_flow`, `dependency`, `capability`, `framework_model`, `configuration`, or `consistency`. The distinct name avoids colliding with `RecordEnvelope.category`, whose value is always `diagnostic` for this record type.
- `severity` expresses required attention and is `info`, `warning`, or `error`. It does not determine completeness.
- `completeness_effect` is `none`, `local`, or `capability` and identifies the breadth of the coverage impact.
- `completeness_status` is omitted when `completeness_effect` is `none`; otherwise it is required and is `partial`, `unknown`, `unsupported`, or `stale`. A diagnostic can never set it to `complete`.
- `affected_scopes` is a non-empty list of typed scopes. Its members must satisfy the selected completeness-effect rules.
- `recoverability` is a `DiagnosticRecovery` describing whether and how the condition may be re-evaluated or corrected.
- `summary` is a required concise deterministic explanation suitable for an agent response.
- `detail` is optional bounded explanatory text. It cannot introduce semantics absent from the code definition or payload.
- `evidence_record_ids` cites exact evidence records demonstrating the condition. It may be empty when the diagnostic directly reports a failed or unsupported analyzer operation at the primary source span.
- `payload` is validated by the selected diagnostic code's registered payload schema. Undeclared payload fields are rejected.

Every source-derived diagnostic retains the mandatory owner artifact and exact owner artifact version from `RecordEnvelope`. A global failure with no responsible source artifact is not assigned fictitious ownership; it is represented as an `OperationError` or indexer control-plane state.

#### Diagnostic scopes

```text
DiagnosticScope =
  RecordDiagnosticScope |
  ArtifactDiagnosticScope |
  CapabilityDiagnosticScope

RecordDiagnosticScope
  scope_type = record
  record_id

ArtifactDiagnosticScope
  scope_type = artifact
  artifact_id
  artifact_version_id

CapabilityDiagnosticScope
  scope_type = capability
  capability
  artifact_ids[]
```

- `scope_type` is the required union discriminator.
- `RecordDiagnosticScope.record_id` identifies one exact canonical record version affected by the condition.
- `ArtifactDiagnosticScope.artifact_id` and `artifact_version_id` identify one exact source occurrence affected by the condition.
- `CapabilityDiagnosticScope.capability` is a stable namespaced capability.
- `artifact_ids` narrows the capability impact to known artifacts and may be empty only when the affected artifacts cannot be enumerated.
`local` requires at least one record or artifact scope. `capability` requires at least one capability scope. Additional scopes may explain propagation, but cannot contradict the selected effect.

#### Recovery model

```text
DiagnosticRecovery
  state
  actions[]
```

- `state` is `automatic`, `action_required`, `unrecoverable`, or `unknown`.
- `actions` is a deduplicated set containing `source_change`, `dependency_change`, `configuration_change`, `model_update`, `plugin_upgrade`, `reindex`, or `manual_action`.
- `actions` must be non-empty for `automatic` and `action_required` and empty for `unrecoverable`.
- `automatic` means Urdira knows which observed dependency changes trigger re-evaluation; it does not guarantee that re-evaluation will remove the diagnostic.
- `unknown` permits an empty action set because no recovery route is established.

#### Diagnostic identity and lifecycle

Logical identity is derived from:

```text
workspace_id
+ diagnostic_code
+ owner_artifact_id
+ semantic_anchor
+ affected_capability
+ producer
```

A changed, continuously present occurrence creates a new `record_id` version under the same `diagnostic_id`. When the condition disappears, the current record and lifecycle identity close in the new generation. A later recurrence receives a new `diagnostic_id` even when its `diagnostic_key` is identical. Changing only `summary`, `detail`, severity, evidence, or source offsets during continuous presence does not change logical identity. Changing the code, semantic anchor, affected capability, owner artifact, or producer creates a new diagnostic identity.

Source spans locate a condition but do not independently define identity because offsets move during edits. Owner and dependency indexes invalidate diagnostics using the same generation and reverse-artifact rules as all other canonical knowledge.

#### Completeness interaction

Severity and completeness impact are independent. Urdira applies a diagnostic to a query only when its affected scope intersects the query scope and its capability is relevant to a stage used by that query.

- `none` leaves completeness unchanged but may still explain uncertainty or provide useful information.
- `local` contributes its status only to intersecting records or artifacts and affected capabilities.
- `capability` contributes its status to the named capability within the declared artifact scope.
Publication-blocking conditions are candidate control-plane state and use `CandidateIssue`. A source diagnostic can degrade only the published knowledge scope it owns; it cannot refer to or block a snapshot that does not exist.

A warning outside the query scope cannot degrade the query's `CompletenessReport`. A globally absent capability is reported as `unsupported` in the completeness dimension without inventing a source-owned diagnostic; a canonical diagnostic is added only when a concrete source construction or artifact is affected.

#### Diagnostic code registry

```text
DiagnosticCodeDefinition
  code
  definition_revision
  schema_version
  diagnostic_category
  title
  description
  non_meaning
  emission_condition
  default_severity
  allowed_severities[]
  default_completeness_effect
  default_completeness_status?
  allowed_completeness_effects[]
  allowed_completeness_statuses[]
  allowed_scope_types[]
  affected_capabilities[]
  recovery
  payload_schema
  agent_guidance
  examples[]
  plugin_owner?
  lifecycle_state
  deprecated_since?
  retired_since?
  replacement_code?
```

- `code` is the stable namespaced diagnostic identifier.
- `definition_revision` is the positive monotonic revision of the complete diagnostic definition and increases for every published change, including guidance or examples.
- `schema_version` is the positive monotonic version of the diagnostic occurrence and payload validation contract. Metadata-only definition changes retain it.
- `diagnostic_category` is the immutable universal category assigned to the code.
- `title` is a short stable display name.
- `description` defines what the diagnostic means.
- `non_meaning` explicitly states conclusions that must not be inferred from the diagnostic.
- `emission_condition` specifies the exact necessary condition under which a producer may emit the code.
- `default_severity` is the severity used unless the definition permits a contextual override.
- `allowed_severities` is the closed set of legal contextual severities and must contain the default.
- `default_completeness_effect` defines the ordinary breadth of the coverage impact.
- `default_completeness_status` defines the ordinary non-complete coverage status. It is required unless the default effect is `none` and omitted when the default effect is `none`.
- `allowed_completeness_effects` is the closed set of legal contextual effect overrides and must contain the default effect.
- `allowed_completeness_statuses` is the closed set of legal contextual status overrides, must contain every non-omitted default status, and can never contain `complete`.
- `allowed_scope_types` is the closed set of diagnostic scope discriminators accepted for the code.
- `affected_capabilities` lists the capabilities that may be degraded by this condition.
- `recovery` is the default `DiagnosticRecovery`; a record may narrow it only as permitted by the definition.
- `payload_schema` describes every allowed payload field, including type, presence, enum, range, and interaction rules.
- `agent_guidance` states the concrete interpretation or action useful to a coding agent.
- `examples` contains at least one complete valid emission and may also contain invalid counterexamples.
- `plugin_owner` is the immutable globally unique `plugin_id` that owns a plugin-defined code and is omitted for core codes.
- `lifecycle_state` is `active`, `deprecated`, or `retired` and controls whether new diagnostic occurrences may use the code.
- `deprecated_since` is required for deprecated or retired codes and identifies the first discouraging `definition_revision`; it is omitted for active codes.
- `retired_since` is required exactly for retired codes and identifies the first revision forbidding new occurrences.
- `replacement_code` is the optional semantic replacement for a deprecated or retired code and is omitted for active codes. It is guidance, not an alias.

Published codes cannot change meaning. An incompatible semantic change requires a new code. Deprecated definitions remain available while any retained snapshot may reference them. The initial core registry is defined in [Core diagnostic codes](../diagnostics/core-diagnostic-codes.md).

#### Agent-facing diagnostic report

```text
DiagnosticReport
  total
  returned
  by_severity
  by_completeness_effect
  diagnostics[]
  has_more
  cursor?

DiagnosticView
  diagnostic_record_id
  diagnostic_code
  code_definition_revision
  code_schema_version
  title
  diagnostic_category
  severity
  completeness_effect
  completeness_status?
  summary
  detail?
  affected_scopes[]
  recovery
  agent_guidance
  source
  evidence_summary?
```

`DiagnosticReport` fields:

- `total` is the number of diagnostics matching the requested scope and inclusion policy before pagination.
- `returned` is the number hydrated in the current response.
- `by_severity` is an object with exact non-negative counts for `info`, `warning`, and `error` across the full matching set.
- `by_completeness_effect` is an object with exact non-negative counts for `none`, `local`, and `capability` across the full matching set.
- `diagnostics` contains the current page of `DiagnosticView` values in deterministic order.
- `has_more` is true exactly when additional matching diagnostics remain after this page.
- `cursor` is present exactly when `has_more` is true and continues the snapshot-pinned diagnostic stream.

`DiagnosticView` fields:

- `diagnostic_record_id` identifies the exact canonical diagnostic version represented by the view.
- `diagnostic_code` is its stable namespaced registered code.
- `code_definition_revision` identifies the exact complete code definition used by the pinned registry snapshot.
- `code_schema_version` identifies the diagnostic occurrence and payload contract used to validate the record; `code_definition_revision` selects the exact guidance and complete registry metadata.
- `title` is copied from that registered definition.
- `diagnostic_category` retains the canonical universal category assigned by the registered code.
- `severity` retains the canonical attention level for this occurrence.
- `completeness_effect` retains the canonical breadth of its coverage impact.
- `completeness_status` retains the canonical non-complete status and follows the same presence rule as `DiagnosticRecord`.
- `summary` is always present and is the concise occurrence-specific explanation.
- `detail` is present only when explicitly requested and available within the response budget.
- `affected_scopes` contains the scopes relevant to the current query projection; omitted matching scopes remain discoverable through the diagnostic cursor rather than being silently discarded.
- `recovery` is the effective `DiagnosticRecovery` for this occurrence.
- `agent_guidance` is the concise registered interpretation or next action, included to avoid a separate registry lookup.
- `source` is the mandatory primary `SourceReferenceView` derived from the diagnostic's owner artifact, version, and source span.
- `evidence_summary` is present when evidence inclusion is requested and the diagnostic has associated evidence.

#### Diagnostic request controls

```text
DiagnosticIncludeOptions
  diagnostics
  diagnostic_detail
```

- `diagnostics` is `none`, `relevant`, or `all` and defaults to `relevant`. `relevant` includes only diagnostics that affect returned results, used query stages, or reported completeness. `all` selects every diagnostic in the explicit query scope. `none` omits diagnostic items but never hides completeness statuses or aggregate counts.
- `diagnostic_detail` is a boolean defaulting to false. When true, `DiagnosticView.detail` may be included within the response budget.

Diagnostic hydration is budgeted and paginated. The report and cursor remain pinned to the parent query execution and snapshot.

#### Operational errors

```text
OperationError
  code
  message
  retryable
  recovery_action?
  workspace_id?
  query_execution_id?
  details?

OperationErrorCodeDefinition
  code
  definition_revision
  schema_version
  description
  retryable_default
  recovery_actions[]
  details_schema
  lifecycle_state
  deprecated_since?
  retired_since?
  replacement_code?
```

`OperationError` fields:

- `code` is a stable protocol error identifier registered separately from diagnostic codes.
- `message` is a concise deterministic explanation of this occurrence.
- `retryable` states whether repeating the same logical operation may succeed after the declared recovery action; it is not a guarantee.
- `recovery_action` is present when the registry defines a concrete caller action and omitted otherwise.
- `workspace_id` is present when the rejected operation resolved an explicit workspace scope.
- `query_execution_id` is present when the failure concerns an existing cached query execution.
- `details` is an optional typed object validated by the selected error code's details schema.

`OperationErrorCodeDefinition` fields:

- `code` is the stable namespaced protocol identifier, such as `core:cursor_expired`, `core:workspace_not_found`, or `core:index_unavailable`.
- `definition_revision` is the positive monotonic revision of the complete definition; it changes for every published metadata or behavioral edit.
- `schema_version` is the positive version of the `OperationError` occurrence and closed details schema; metadata-only revisions retain it.
- `description` defines its exact trigger and interpretation.
- `retryable_default` supplies the ordinary retry behavior.
- `recovery_actions` is the closed set of actions an occurrence may expose.
- `details_schema` documents and validates every optional details field.
- `lifecycle_state`, `deprecated_since`, `retired_since`, and `replacement_code` follow the common immutable registry lifecycle and preserve retained protocol interpretation.

Operation-error definitions are core-owned in the initial public API contract; plugins cannot contribute or emit new codes. Operation errors are response protocol values, not knowledge records. They are never persisted as `DiagnosticRecord` automatically. A source-owned diagnostic may additionally be created only when an exact artifact and analysis limitation remain represented in an indexed or failed generation.

The complete initial operation-error registry—including request, scope, planning, freshness, execution, index, pagination, semantic, and hydration failures—is defined in [Core operation error codes](../protocol/core-operation-error-codes.md).

### DerivedProjectionEnvelope

Derived projections do not extend `RecordEnvelope` because they are not canonical knowledge records. They preserve equivalent source ownership and provenance through a projection envelope:

```text
DerivedProjectionEnvelope
  projection_record_id
  projection_kind
  projection_key
  workspace_id
  owner_artifact_id
  owner_artifact_version_id
  source_artifact_version_ids[]
  source_record_ids[]
  source_projection_record_ids[]
  generator
  generator_version
  generator_configuration_digest
  created_from_snapshot_id
  valid_from_generation
  valid_to_generation?
  payload
  content_digest
```

Every logical projection is granular and has one indexed owner artifact. Physical indexes may aggregate entries, but no source-derived projection record is ownerless. `projection_key` identifies a logical slot without becoming a reopenable temporal identity. `source_artifact_version_ids` is non-empty, complete, and includes `owner_artifact_version_id`. `source_record_ids` and `source_projection_record_ids` are complete and may be empty when the projection does not directly use that source category. `created_from_snapshot_id` records provenance; visibility is controlled only by the half-open generation interval.

The payload uses the closed schema registered for `projection_kind`. An unchanged projection remains open across generations. Any change to content, sources, owner, generator, generator version, or generator configuration closes the old projection and creates another `projection_record_id`. Closing any source artifact version, canonical record, or source projection closes dependent projections atomically. The three dependency lists are reverse indexed. `valid_to_generation` is the only monotonic mutation and is excluded from `content_digest`. Projections required by retained snapshots retain their original generator and configuration.

```text
ProjectionChange
  projection_change_id
  change_action
  projection_record_id
  projection_kind
  projection_key
  workspace_id
  owner_artifact_id
  owner_artifact_version_id
  source_artifact_version_ids[]
  source_record_ids[]
  source_projection_record_ids[]
  generator
  generator_version
  generator_configuration_digest
  generation
  change_reason_code
  previous_projection_record_id?
  replacement_projection_record_id?
  cause_references[]
```

`change_action` is `opened` or `closed`. Direct predecessor and replacement links are conditional and reciprocal. Final source deletion closes without replacement. Projection change reason codes are registered `LifecycleReasonCodeDefinition` values in the `projection_open` or `projection_close` domain. The initial codes are `core:projection_source_opened`, `core:projection_source_revised`, `core:projection_source_closed`, `core:projection_generator_changed`, `core:projection_configuration_changed`, and `core:projection_reconciliation_corrected`; each definition restricts whether it may open, close, or do both. No entry is emitted for an unchanged projection.

Exact projection field contracts:

| Model.field | Exact meaning |
|---|---|
| `DerivedProjectionEnvelope.projection_record_id` | Identity of one exact derived projection occurrence. |
| `DerivedProjectionEnvelope.projection_kind` | Registered closed payload schema and index behavior. |
| `DerivedProjectionEnvelope.projection_key` | Reproducible logical slot key, not a reopenable identity. |
| `DerivedProjectionEnvelope.workspace_id` | Workspace whose generation interval governs visibility. |
| `DerivedProjectionEnvelope.owner_artifact_id` | Indexed exact primary source artifact. |
| `DerivedProjectionEnvelope.owner_artifact_version_id` | Indexed exact primary source version. |
| `DerivedProjectionEnvelope.source_artifact_version_ids` | Non-empty complete exact artifact-version dependency set, including the owner version. |
| `DerivedProjectionEnvelope.source_record_ids` | Complete exact direct canonical source-record set; empty when no canonical record is a direct input. |
| `DerivedProjectionEnvelope.source_projection_record_ids` | Complete exact direct derived-projection input set; empty when no projection is a direct input. |
| `DerivedProjectionEnvelope.generator` | Registered runtime-component identity. |
| `DerivedProjectionEnvelope.generator_version` | Exact component version with the `projection_generator` contract required by the projection kind. |
| `DerivedProjectionEnvelope.generator_configuration_digest` | Digest of all output-affecting generator configuration. |
| `DerivedProjectionEnvelope.created_from_snapshot_id` | Snapshot materialization from which generation began; not a visibility selector. |
| `DerivedProjectionEnvelope.valid_from_generation` | First generation containing the projection. |
| `DerivedProjectionEnvelope.valid_to_generation` | First generation not containing it; absent while current. |
| `DerivedProjectionEnvelope.payload` | Value validated by the projection-kind schema. |
| `DerivedProjectionEnvelope.content_digest` | UCE digest governed by `core:derived_projection_content_digest`; `valid_to_generation` is excluded by its positive binding. |
| `ProjectionChange.projection_change_id` | Idempotent identity of one projection opening or closure. |
| `ProjectionChange.change_action` | `opened` or `closed`. |
| `ProjectionChange.projection_record_id` | Exact affected projection. |
| `ProjectionChange.projection_kind` | Registered projection schema. |
| `ProjectionChange.projection_key` | Logical slot copied from the projection. |
| `ProjectionChange.workspace_id` | Indexed workspace copied from the projection. |
| `ProjectionChange.owner_artifact_id` | Indexed exact owner copied from the projection. |
| `ProjectionChange.owner_artifact_version_id` | Indexed exact owner version copied from the projection. |
| `ProjectionChange.source_artifact_version_ids` | Complete exact artifact-version inputs copied from the projection. |
| `ProjectionChange.source_record_ids` | Complete exact canonical inputs copied from the projection. |
| `ProjectionChange.source_projection_record_ids` | Complete exact projection inputs copied from the projection. |
| `ProjectionChange.generator` | Registered generator identity. |
| `ProjectionChange.generator_version` | Exact generator version. |
| `ProjectionChange.generator_configuration_digest` | Exact generator configuration digest. |
| `ProjectionChange.generation` | Opening or closing manifest generation. |
| `ProjectionChange.change_reason_code` | Registered exact causal reason. |
| `ProjectionChange.previous_projection_record_id` | Direct predecessor, allowed only on opening. |
| `ProjectionChange.replacement_projection_record_id` | Direct replacement, allowed only on closure. |
| `ProjectionChange.cause_references` | Exact source or control-plane causes. |

### Approved semantic retrieval and embedding model

Semantic retrieval uses a source-owned layered pipeline:

```text
ArtifactVersion
  -> DerivedSemanticEligibility
  -> DerivedSemanticDocument
       -> artifact content view
       -> entity content views
  -> DerivedEmbeddingSegment
  -> DerivedEmbeddingVector
  -> SemanticIndexMaterialization
```

Documents are independent from embedding models. Segments adapt documents to one immutable profile, and vectors encode one exact segment. No layer introduces independent code truth or proves a structural relationship. Semantic matches are discovery candidates that must resolve back to canonical entities, records, or artifacts before structural expansion.

Projection keys use stable logical slots:

- Eligibility: owner artifact identity.
- Artifact document: owner artifact identity plus the `artifact` subject discriminator.
- Entity document: entity lifecycle identity plus the `entity` subject discriminator.
- Segment: semantic-document projection key, embedding profile, and segment ordinal.
- Vector: embedding-segment projection key and embedding profile.

The occurrence IDs, exact inputs, and generation interval distinguish revisions. Profile identity in segment and vector keys permits parallel model spaces. A closed occurrence never reopens even when its projection key and content later reappear.

#### DerivedSemanticEligibility

```text
DerivedSemanticEligibility extends DerivedProjectionEnvelope
  artifact_id
  artifact_version_id
  content_class
  language_ids[]
  eligibility_status
  reason_codes[]
  matched_policy_rule_ids[]
  diagnostic_record_ids[]
```

| Field | Exact meaning |
|---|---|
| `artifact_id` | Exact assessed artifact; it equals the envelope owner artifact. |
| `artifact_version_id` | Exact assessed occurrence; it equals the envelope owner artifact version and appears in `source_artifact_version_ids`. |
| `content_class` | `source_code`, `prose`, `configuration`, `markup`, `data`, `unknown_text`, or `binary`. |
| `language_ids` | Canonically ordered registered languages detected in the artifact; empty when none can be classified. |
| `eligibility_status` | `eligible`, `excluded`, `unsupported`, or `failed`. |
| `reason_codes` | Registered `SemanticReasonDefinition` identifiers legal for this status. It is empty only for an unqualified `eligible` decision. |
| `matched_policy_rule_ids` | Exact configuration rules that explicitly included or excluded the artifact; empty when defaults decided eligibility. |
| `diagnostic_record_ids` | Exact source-owned diagnostics supporting `unsupported` or `failed`; every identifier also appears in the envelope source-record set. |

Eligibility is independent from an embedding profile. Every textual artifact inside the configured source scope is eligible by default. Binary input and explicit policy exclusions are represented rather than silently omitted. An explicit exclusion does not reduce completeness for the resulting configured scope. Unsupported or failed text inside that scope does.

#### DerivedSemanticDocument

```text
DerivedSemanticDocument extends DerivedProjectionEnvelope
  subject
  content_class
  language_ids[]
  display_title
  sections[]
  semantic_content_digest

SemanticDocumentSubject =
  ArtifactSemanticDocumentSubject |
  EntitySemanticDocumentSubject

ArtifactSemanticDocumentSubject
  subject_type = artifact
  artifact_id
  artifact_version_id

EntitySemanticDocumentSubject
  subject_type = entity
  entity_id
  entity_record_id

SemanticDocumentSection
  section_key
  ordinal
  section_kind
  language_id?
  origin_kind
  text
  source_spans[]
  source_record_ids[]
  section_digest
```

`DerivedSemanticDocument` fields:

| Field | Exact meaning |
|---|---|
| `subject` | Exactly one artifact or entity subject variant. |
| `content_class` | Same closed textual class vocabulary as eligibility, excluding `binary`. |
| `language_ids` | Canonically ordered languages represented in the complete document. |
| `display_title` | Deterministic concise title used for result hydration; it is not a generated summary. |
| `sections` | Non-empty list in rendering order. Section ordinals are zero-based and contiguous. |
| `semantic_content_digest` | Digest of the complete ordered section representation consumed by segmenters, including section provenance. |

Subject fields:

| Field | Exact meaning |
|---|---|
| `ArtifactSemanticDocumentSubject.subject_type` | Fixed discriminator `artifact`. |
| `ArtifactSemanticDocumentSubject.artifact_id` | Exact artifact represented; it equals the envelope owner. |
| `ArtifactSemanticDocumentSubject.artifact_version_id` | Exact represented occurrence; it equals the envelope owner version. |
| `EntitySemanticDocumentSubject.subject_type` | Fixed discriminator `entity`. |
| `EntitySemanticDocumentSubject.entity_id` | Lifecycle identity of the represented entity. |
| `EntitySemanticDocumentSubject.entity_record_id` | Exact visible canonical entity record used to build the document and present in `source_record_ids`. |

`SemanticDocumentSection` fields:

| Field | Exact meaning |
|---|---|
| `section_key` | Deterministic key unique inside one semantic document; it is not a global identity. |
| `ordinal` | Zero-based contiguous rendering position. |
| `section_kind` | Registered `SemanticSectionKindDefinition` identifier. |
| `language_id` | Registered language for this section when known; omitted for language-neutral metadata or unclassified text. |
| `origin_kind` | `source_text`, `record_rendering`, or `artifact_metadata`. |
| `text` | Exact deterministic section text. Generated natural-language summaries are forbidden. |
| `source_spans` | Ordered exact source regions rendered by the section. It is non-empty for `source_text` and may be empty for the other origin kinds. |
| `source_record_ids` | Complete direct canonical records rendered in this section; every value is also an envelope dependency. |
| `section_digest` | Digest of kind, language, origin, text, spans, and record inputs. |

An artifact document is mandatory for every eligible textual artifact. The union of its `source_text` spans covers the complete decoded artifact text without gaps. Entity documents provide additional precise views and never replace the artifact document. Documents may include deterministic path, identity, signature, documentation, implementation, relationship-context, source-content, and keyword sections. A document may mention locally observed qualified relationship targets but never copies foreign source, documentation, or implementation content. Cross-artifact context is added during structural expansion or ranking to prevent transitive re-embedding cascades.

Every semantic document directly references its governing eligibility projection in `source_projection_record_ids`. Every segment directly references its document, and every vector directly references its segment. These dependencies make eligibility changes and source closure cascade without relying on payload inspection.

#### DerivedEmbeddingSegment

```text
DerivedEmbeddingSegment extends DerivedProjectionEnvelope
  semantic_document_projection_id
  embedding_profile_id
  runtime_component_build_id
  implementation_digest
  segment_ordinal
  segmentation_method
  primary_source_span
  source_spans[]
  parts[]
  token_count
  embedding_input
  embedding_input_digest

EmbeddingSegmentPart
  part_ordinal
  input_role
  section_key
  section_start_byte
  section_end_byte
  input_start_byte
  input_end_byte
  source_spans[]
```

`DerivedEmbeddingSegment` fields:

| Field | Exact meaning |
|---|---|
| `semantic_document_projection_id` | Exact document occurrence segmented; it is present in `source_projection_record_ids`. |
| `embedding_profile_id` | Immutable profile whose tokenizer, renderer, limits, and segmentation contract apply. |
| `runtime_component_build_id` | Exact local segmenter build selected by the materialization's executable binding. |
| `implementation_digest` | Exact verified executable digest of that segmenter build. |
| `segment_ordinal` | Zero-based contiguous segment position for this document and profile. |
| `segmentation_method` | `semantic_region`, `semantic_pack`, or `fallback_window`. |
| `primary_source_span` | Exact main source location returned for a semantic match. It is a member of `source_spans`. |
| `source_spans` | Non-empty canonically ordered complete set of source regions represented by the segment. |
| `parts` | Non-empty ordered mapping from document ranges to rendered input ranges. |
| `token_count` | Exact token count under the profile tokenizer; it never exceeds `maximum_document_tokens`. |
| `embedding_input` | Exact UTF-8 text supplied to the embedding generator. |
| `embedding_input_digest` | Digest of the exact UTF-8 bytes in `embedding_input`. |

`EmbeddingSegmentPart` fields:

| Field | Exact meaning |
|---|---|
| `part_ordinal` | Zero-based contiguous position inside the segment. |
| `input_role` | `primary` for content whose semantic match is being represented, or `context` for repeated deterministic context. |
| `section_key` | Source section inside the referenced semantic document. |
| `section_start_byte`, `section_end_byte` | Half-open UTF-8 byte range inside that section's `text`. |
| `input_start_byte`, `input_end_byte` | Half-open UTF-8 byte range occupied by that part inside `embedding_input`. |
| `source_spans` | Exact source spans contributing to this part; empty only for non-source context. |

Segmenters prefer plugin-provided semantic regions, then semantic subregions or contiguous semantic packing, and use deterministic overlapping windows only as a last resort. Unrelated non-contiguous source regions cannot be packed solely to fill a model window. Every segment has at least one primary source part. Across all segments of a supported artifact document, primary parts cover every source-text byte without gaps; overlap is allowed and silent truncation is forbidden. Template bytes need not map to a section but are fixed by the profile's document input contract.

For this projection subtype, the inherited `generator`, `generator_version`, and `generator_configuration_digest` are the exact segmenter component and the complete `ModelPackRuntimeConfiguration.configuration_digest` whose role is `segmenter` for this profile. This specialization overrides the generic derived-projection configuration reference; a segment produced under any other configuration cannot enter the profile's materialization.

#### DerivedEmbeddingVector

```text
DerivedEmbeddingVector extends DerivedProjectionEnvelope
  embedding_segment_projection_id
  embedding_profile_id
  runtime_component_build_id
  implementation_digest
  embedding_input_digest
  dimensions
  element_type
  vector_encoding
  normalization
  vector_bytes
  vector_digest
```

| Field | Exact meaning |
|---|---|
| `embedding_segment_projection_id` | Exact encoded segment and direct source projection. |
| `embedding_profile_id` | Immutable vector space containing the result. |
| `runtime_component_build_id` | Exact local embedding-generator build selected by the materialization's executable binding. |
| `implementation_digest` | Exact verified executable digest of that generator build. |
| `embedding_input_digest` | Exact segment input digest; mismatch rejects the projection. |
| `dimensions` | Positive vector dimension equal to the profile dimension. |
| `element_type` | Element representation equal to the profile value. |
| `vector_encoding` | Canonical binary layout equal to the profile value. |
| `normalization` | Applied normalization equal to the profile value. |
| `vector_bytes` | Exact canonical encoded vector bytes. They are not returned by ordinary agent queries. |
| `vector_digest` | Digest of `vector_bytes` only; the inherited `content_digest` covers all vector metadata and provenance. |

Encoded lengths must satisfy the selected profile. Non-finite values are forbidden. L2 profiles reject a zero vector or a vector that violates the profile normalization tolerance. For this projection subtype, the inherited `generator`, `generator_version`, and `generator_configuration_digest` are the exact embedding-generator component and the complete `ModelPackRuntimeConfiguration.configuration_digest` whose role is `generator` for this profile. The generator must produce identical bytes for identical input, profile, generator implementation, and that configuration digest. Its closed typed value fixes every output-affecting runtime choice; adaptive hardware detection, platform defaults, and `auto` behavior are forbidden. A semantic query uses the same generator lock as every selected vector and materialization; it never substitutes another runtime silently.

#### SemanticArtifactCoverage

```text
SemanticArtifactCoverage
  semantic_artifact_coverage_id
  semantic_index_materialization_id
  workspace_id
  snapshot_id
  generation
  embedding_profile_id
  owner_artifact_id
  owner_artifact_version_id
  eligibility_projection_record_id
  coverage_status
  semantic_document_count
  embedding_segment_count
  embedding_vector_count
  reason_codes[]
  diagnostic_record_ids[]
  artifact_projection_set_digest
  coverage_digest
```

| Field | Exact meaning |
|---|---|
| `semantic_artifact_coverage_id` | Immutable identity of one artifact's coverage inside one materialization. |
| `semantic_index_materialization_id` | Exact aggregate materialization containing this entry. |
| `workspace_id`, `snapshot_id`, `generation` | Exact published workspace state assessed. |
| `embedding_profile_id` | Profile for which coverage is measured. |
| `owner_artifact_id`, `owner_artifact_version_id` | Indexed exact source occurrence governed by this entry. |
| `eligibility_projection_record_id` | Exact visible eligibility projection used to decide the artifact state. |
| `coverage_status` | `covered`, `pending`, `excluded`, `unsupported`, or `failed`. |
| `semantic_document_count` | Exact visible semantic-document count for this artifact, including the artifact view and entity views. |
| `embedding_segment_count` | Exact visible segment count for the profile. |
| `embedding_vector_count` | Exact visible vector count for those segments. |
| `reason_codes` | Registered semantic reasons legal for this status. |
| `diagnostic_record_ids` | Exact source diagnostics supporting unsupported or failed coverage. |
| `artifact_projection_set_digest` | Digest of every visible semantic document, segment, and vector projection for this artifact and profile. |
| `coverage_digest` | UCE digest governed by `core:semantic_artifact_coverage_digest` and its explicit positive payload binding. |

`covered` requires an artifact document and one vector per segment. An eligible empty textual artifact may be covered with zero segments. `pending` is legal only when missing vector work is actually scheduled. `excluded` must follow an explicit eligible-scope policy and does not reduce completeness. `unsupported` or `failed` requires a reason; `failed` also requires a diagnostic. Entries never mutate: a later snapshot creates another coverage identity even when state is identical.

#### SemanticIndexMaterialization

The artifact coverage set has a typed descriptor:

```text
SemanticCoverageManifest extends OrderedSetDescriptor
  semantic_index_materialization_id
```

- `descriptor_id` is the materialization's `coverage_manifest_id`.
- `element_type` is fixed to `SemanticArtifactCoverage`.
- `comparator_id` is fixed to `core:semantic_coverage_order` and `comparator_version` is fixed to `1` for this initial schema version.
- `entry_count` equals the materialization `artifact_count`.
- `content_digest` equals `coverage_manifest_digest`.
- `semantic_index_materialization_id` is the sole materialization whose immutable entries the descriptor contains.

```text
SemanticIndexMaterialization
  semantic_index_materialization_id
  schema_version
  workspace_id
  snapshot_id
  generation
  embedding_profile_id
  embedding_profile_digest
  executable_binding_digest
  generator
  generator_version
  generator_configuration_digest
  materialization_state
  coverage_manifest_id
  coverage_manifest_digest
  artifact_count
  covered_artifact_count
  pending_artifact_count
  excluded_artifact_count
  unsupported_artifact_count
  failed_artifact_count
  semantic_document_count
  embedding_segment_count
  embedding_vector_count
  queryable_vector_set_digest
  predecessor_materialization_id?
  published_at
  materialization_digest
```

| Field | Exact meaning |
|---|---|
| `semantic_index_materialization_id` | Immutable identity of one workspace, snapshot, profile, and generator materialization. |
| `schema_version` | Positive version of this closed control-plane schema. |
| `workspace_id`, `snapshot_id`, `generation` | Exact immutable published code and projection state represented. |
| `embedding_profile_id`, `embedding_profile_digest` | Exact registry profile and definition digest. |
| `executable_binding_digest` | Exact locally resolved portable profile plus four runtime builds used by every semantic projection in this materialization. |
| `generator`, `generator_version`, `generator_configuration_digest` | Exact inference implementation and model-pack runtime-configuration lock required for indexed and query vectors. |
| `materialization_state` | Derived aggregate state: `complete`, `updating`, `degraded`, or `unavailable`. |
| `coverage_manifest_id` | Immutable pageable manifest containing exactly one `SemanticArtifactCoverage` entry per artifact in scope. |
| `coverage_manifest_digest` | Digest of the manifest's canonical complete entry order. |
| `artifact_count` | Total manifest entries and exact sum of the five status counts. |
| `covered_artifact_count` | Entries with `covered`. |
| `pending_artifact_count` | Entries with `pending`. |
| `excluded_artifact_count` | Entries with `excluded`. |
| `unsupported_artifact_count` | Entries with `unsupported`. |
| `failed_artifact_count` | Entries with `failed`. |
| `semantic_document_count`, `embedding_segment_count`, `embedding_vector_count` | Exact sums across all coverage entries. |
| `queryable_vector_set_digest` | Digest of the exact visible vector projection set supplied to retrieval. |
| `predecessor_materialization_id` | Previous published materialization for the same workspace and profile, when one exists. |
| `published_at` | Snapshot publication timestamp; it is informational and immutable. |
| `materialization_digest` | UCE digest governed by `core:semantic_index_materialization_digest` and its explicit positive payload binding. |

`complete` means every included compatible artifact is covered, including a valid empty corpus with zero segments and vectors. `updating` means pending work exists and no permanent gap exists. `degraded` means failed or unsupported included content exists while some semantic retrieval remains usable. `unavailable` means the materialization cannot supply the required retrieval contract because its vector set is missing or unreadable; an empty but fully covered corpus is not unavailable. Excluded artifacts do not degrade state. Counts and state are validated rather than accepted as independent claims. The materialization is included in the snapshot's capability-state digest; a later projection-only generation creates a new materialization instead of mutating it. Its `generator + generator_version` resolves a runtime component with a compatible `embedding_generator` contract binding.

#### Incremental invalidation and computation reuse

When an artifact changes or disappears, publication closes every old eligibility, document, segment, and vector projection reachable through reverse dependencies. The new snapshot may publish documents and segments with `pending` coverage before vector generation finishes. Old vectors are never used for the changed occurrence. Completed embeddings are published in a later projection-only generation. A build based on an obsolete snapshot is rejected and replanned.

Logical identity and physical computation reuse are separate. A vector computation may be reused across files or workspaces only under the exact key:

```text
(embedding_input_digest, embedding_profile_id, generator, generator_version, resolved_implementation_digest, generator_configuration_digest)
```

The reused bytes do not share logical projection identity, ownership, source version, or validity. Closing and later recreating identical source always creates new document, segment, vector, and coverage occurrences while allowing byte-level reuse.

Moving a workspace or retained index to another operating system or architecture never rewrites its executable binding. If the target installation lacks any exact retained `RuntimeComponentBuild.implementation_digest`, that semantic materialization is unavailable there. Urdira may construct a new executable binding from platform-appropriate builds sharing the portable behavior digests and rebuild segments and vectors into a new materialization; it cannot relabel or append to the old one. Canonical structural knowledge remains portable independently of this semantic rebuild.

Executable bindings are part of vector-lane identity. Vectors created under different executable binding digests never enter the same materialization, reuse set, or raw-similarity lane even when their portable `embedding_profile_id` is identical. A comparison spanning such workspaces creates separate lanes and fuses their independently ranked results through the ordinary deterministic fusion contract.

### FactDelta

Language plugins submit immutable candidate-scoped proposals rather than mutating generations:

```text
FactDelta
  fact_delta_id
  candidate_generation_id
  workspace_id
  base_snapshot_id?
  work_item_id
  plugin_id
  plugin_version
  analysis_digest
  analysis_configuration_digest
  owner_artifact_id
  owner_artifact_version_id
  replacement_scopes[]
  input_artifact_version_ids[]
  input_record_ids[]
  plugin_input_access_manifest_id
  plugin_input_access_manifest_digest
  analysis_input_digest
  proposed_records[]
  proposed_dependencies[]
  completeness_claims[]
  created_at
  delta_digest
```

A delta never names a numeric target generation. Plugins cannot create artifact versions, assign canonical IDs, close arbitrary records, or publish. The core computes closures by comparing complete replacement scopes, validates every proposal, combines all candidate deltas, resolves identities and references, and only then assigns records and generation intervals. `delta_digest` covers every field except the delta identifier and creation timestamp. Repeating an ID with the same digest is idempotent; repeating it with a different digest rejects the candidate.

```text
ReplacementScope
  replacement_scope_id
  owner_artifact_id
  owner_artifact_version_id
  capability
  record_categories[]
  record_kinds[]
  partition_key?
  base_record_set_digest
  output_completeness

ProposedRecord
  proposal_record_key
  workspace_id
  owner_artifact_id
  owner_artifact_version_id
  category
  kind
  universal_kind
  facets[]
  schema_version
  source_span?
  identity_key?
  body
  evidence_references[]

ProposedRecordDependency
  proposed_dependency_id
  proposal_record_key
  dependency_artifact_id
  dependency_artifact_version_id
  dependency_role
  dependency_basis
  source_reference?

CompletenessClaim
  completeness_claim_id
  capability
  replacement_scope_ids[]
  status
  reason_codes[]
  affected_artifact_ids[]
  diagnostic_proposal_keys[]
```

A replacement scope is closed by registered plugin, artifact, capability, categories, kinds, and optional formally declared partition. Its initial and only `output_completeness` value is `complete`. Missing base records close, identical records reuse, and changed records replace. Scope completeness means the output set is authoritative; it is independent from semantic coverage completeness.

`proposal_record_key` is local to one delta. The body uses the category's typed model, not open JSON. Entity, relation, and diagnostic proposals require identity keys; facts and evidence without continuous identity omit one. Proposal references disappear during canonicalization.

```text
ProposedReference =
  LocalProposalReference
  | CandidateIdentityReference
  | BaseRecordReference
  | UnresolvedReference

LocalProposalReference
  reference_type = "local_proposal"
  proposal_record_key

CandidateIdentityReference
  reference_type = "candidate_identity"
  identity_type
  identity_key
  expected_kinds[]
  required_facets[]

BaseRecordReference
  reference_type = "base_record"
  record_id

UnresolvedReference
  reference_type = "unresolved"
  symbolic_key
  candidate_identity_keys[]
  resolution_reason_code
```

Candidate identity references resolve across every delta and reused active base identity. Base-record references must be declared exact inputs and cannot remain pinned when the selected target class requires a replacement. Unresolved references preserve symbolic observations and candidates; ambiguity never selects a target arbitrarily.

Proposed dependencies identify exact external artifact versions. `dependency_basis` is `direct_input`, `referenced_record`, `evidence_source`, `resolution_target`, or `conservative`. The core adds dependencies implied by references, evidence, base-record transitive closure, staged-record proven closure, and lookup invalidation bindings. A directly referenced artifact must occur in `input_artifact_version_ids`; an artifact reached only through a consumed record must occur in the accepted access manifest's transitive artifact set. Neither path may be supplied only by an unverified plugin assertion.

Completeness claims use `complete`, `partial`, `unknown`, or `unsupported`; only the core may derive `stale`. Non-complete claims require registered reasons. Source-specific limitations cite proposed diagnostics. Evidence confidence (`high`, `medium`, or `low`) remains separate from coverage completeness.

Exact delta and scope field contracts:

| Model.field | Exact meaning |
|---|---|
| `FactDelta.fact_delta_id` | Plugin-supplied idempotency identity for one immutable output. |
| `FactDelta.candidate_generation_id` | Sole candidate authorized to accept the delta. |
| `FactDelta.workspace_id` | Sole workspace of every input and proposal. |
| `FactDelta.base_snapshot_id` | Exact analysis base; absent only for initial indexing. |
| `FactDelta.work_item_id` | Exact artifact work item authorizing execution. |
| `FactDelta.plugin_id` | Registered producer identity. |
| `FactDelta.plugin_version` | Exact producer version. |
| `FactDelta.analysis_digest` | Exact analyzer implementation digest. |
| `FactDelta.analysis_configuration_digest` | Exact output-affecting configuration digest. |
| `FactDelta.owner_artifact_id` | Indexed sole owner artifact authorized by the work item. |
| `FactDelta.owner_artifact_version_id` | Exact owner version analyzed. |
| `FactDelta.replacement_scopes` | Non-empty authoritative scopes whose previous outputs are replaced. |
| `FactDelta.input_artifact_version_ids` | Complete deduplicated direct artifact-version projection derived from the accepted access manifest. |
| `FactDelta.input_record_ids` | Complete deduplicated direct base canonical-record projection derived from the accepted access manifest; staged inputs never masquerade as canonical IDs. |
| `FactDelta.plugin_input_access_manifest_id` | Exact core-observed access manifest for direct, staged, lookup, and transitive inputs. |
| `FactDelta.plugin_input_access_manifest_digest` | Recomputed digest of that complete manifest; disagreement rejects the delta. |
| `FactDelta.analysis_input_digest` | Final digest of request, pinned view, access manifest, implementation/configuration, and call payload used for accepted-output identity and cache reuse. |
| `FactDelta.proposed_records` | Complete typed candidate records emitted for the replacement scopes. |
| `FactDelta.proposed_dependencies` | Declared per-proposal exact external dependencies. |
| `FactDelta.completeness_claims` | Capability coverage claims for every relevant replacement scope. |
| `FactDelta.created_at` | Delta creation time, excluded from semantic digest. |
| `FactDelta.delta_digest` | UCE digest governed by `core:fact_delta_digest`; its positive binding omits `fact_delta_id` and `created_at`. |
| `ReplacementScope.replacement_scope_id` | Identity of one authoritative output boundary within the delta. |
| `ReplacementScope.owner_artifact_id` | Exact single owner artifact. |
| `ReplacementScope.owner_artifact_version_id` | Exact owner occurrence analyzed. |
| `ReplacementScope.capability` | Registered capability whose outputs the scope contains. |
| `ReplacementScope.record_categories` | Non-empty permitted universal categories. |
| `ReplacementScope.record_kinds` | Non-empty registered concrete output kinds. |
| `ReplacementScope.partition_key` | Optional typed partition allowed only by the capability contract. |
| `ReplacementScope.base_record_set_digest` | Digest of the exact visible base records matched by the scope. |
| `ReplacementScope.output_completeness` | Initially only `complete`, making omissions authoritative closures. |
| `ProposedRecord.proposal_record_key` | Delta-local unique reference key removed during canonicalization. |
| `ProposedRecord.workspace_id` | Workspace copied from and validated against the delta. |
| `ProposedRecord.owner_artifact_id` | Indexed owner copied from and validated against the scope. |
| `ProposedRecord.owner_artifact_version_id` | Exact owner version copied from and validated against the scope. |
| `ProposedRecord.category` | Universal structural category selecting the body family. |
| `ProposedRecord.kind` | Registered most precise concrete kind. |
| `ProposedRecord.universal_kind` | Registered core base kind required by the concrete kind. |
| `ProposedRecord.facets` | Deduplicated validated registered structural facets. |
| `ProposedRecord.schema_version` | Exact concrete-kind body schema version. |
| `ProposedRecord.source_span` | Optional half-open byte span inside the owner version. |
| `ProposedRecord.identity_key` | Required typed lifecycle matching input for entity, relation, or diagnostic; a relation uses `RelationIdentityInput` and is finalized only after anchor identity resolution; otherwise absent. |
| `ProposedRecord.body` | Closed typed category body, never undeclared JSON. |
| `ProposedRecord.evidence_references` | Exact proposal-local or visible-base evidence references. |

Reference, dependency, and completeness field contracts:

| Model.field | Exact meaning |
|---|---|
| `LocalProposalReference.reference_type` | Constant discriminator `local_proposal`. |
| `LocalProposalReference.proposal_record_key` | Exact target proposal in the same delta. |
| `CandidateIdentityReference.reference_type` | Constant discriminator `candidate_identity`. |
| `CandidateIdentityReference.identity_type` | Entity, relation, or diagnostic identity domain. |
| `CandidateIdentityReference.identity_key` | Typed reproducible key resolved against the whole candidate. |
| `CandidateIdentityReference.expected_kinds` | Allowed registered target kinds; empty only when the governing role permits any. |
| `CandidateIdentityReference.required_facets` | Facets every resolved entity target must carry. |
| `BaseRecordReference.reference_type` | Constant discriminator `base_record`. |
| `BaseRecordReference.record_id` | Exact visible base record declared in delta inputs. |
| `UnresolvedReference.reference_type` | Constant discriminator `unresolved`. |
| `UnresolvedReference.symbolic_key` | Normalized unresolved symbol or construct key. |
| `UnresolvedReference.candidate_identity_keys` | Complete known deterministic candidate-key set, possibly empty. |
| `UnresolvedReference.resolution_reason_code` | Registered exact reason confirmed resolution failed. |
| `ProposedRecordDependency.proposed_dependency_id` | Delta-local immutable dependency proposal identity. |
| `ProposedRecordDependency.proposal_record_key` | Exact record proposal whose output depends on the artifact. |
| `ProposedRecordDependency.dependency_artifact_id` | Indexed exact external artifact address. |
| `ProposedRecordDependency.dependency_artifact_version_id` | Exact external content occurrence used. |
| `ProposedRecordDependency.dependency_role` | Registered semantic invalidation role. |
| `ProposedRecordDependency.dependency_basis` | Direct input, referenced record, evidence source, resolution target, or conservative basis. |
| `ProposedRecordDependency.source_reference` | Optional exact input or record reference from which the dependency was derived. |
| `CompletenessClaim.completeness_claim_id` | Immutable identity of one candidate coverage assertion. |
| `CompletenessClaim.capability` | Registered capability whose coverage is described. |
| `CompletenessClaim.replacement_scope_ids` | Non-empty exact scopes to which the claim applies. |
| `CompletenessClaim.status` | `complete`, `partial`, `unknown`, or `unsupported`. |
| `CompletenessClaim.reason_codes` | Registered causes; empty only when status is complete. |
| `CompletenessClaim.affected_artifact_ids` | Known exact affected artifacts; empty only when they cannot be enumerated. |
| `CompletenessClaim.diagnostic_proposal_keys` | Source-owned proposed diagnostics supporting non-complete coverage. |


### PluginCapabilityDeclaration

Plugins declare what they can analyze and with what precision:

```text
PluginCapabilityDeclaration
  plugin_id
  plugin_version
  language_id?
  capability
  capability_contract_version
  precision
  coverage
  limitations[]

CapabilityCoverage
  language_ids[]
  artifact_kinds[]
  project_context_required
  excluded_construct_codes[]

CapabilityLimitation
  limitation_code
  applicable_language_ids[]
  applicable_artifact_kinds[]
  applicable_construct_codes[]
  resulting_status
  description
```

- `plugin_id` identifies the declaring plugin.
- `plugin_version` identifies the exact plugin release making the declaration.
- `language_id` identifies the primary language ecosystem for a language analyzer and is required for language plugins. It is absent for a language-neutral bridge or enricher.
- `capability` is the stable namespaced capability identifier.
- `capability_contract_version` is the exact normalized SemVer version of the behavioral guarantees implemented for this capability.
- `precision` is exactly one of `syntactic`, `resolved`, `typed`, `flow_sensitive`, `modeled`, or `heuristic`. It describes the principal derivation method, is restricted by the capability definition, and is not a quality ordering.
- `coverage` is the complete declared static scope. It is metadata for compatibility and planning, never a substitute for snapshot capability state.
- `limitations` is a duplicate-free bounded set of structured conditions under which the capability is incomplete or unavailable.

`CapabilityCoverage` fields:

- `language_ids` is the non-empty set of accepted indexed language identifiers for a language plugin and may be empty only for a language-neutral plugin.
- `artifact_kinds` is the non-empty set of values from the closed `SourceArtifact.artifact_kind` vocabulary accepted by the capability. It is not another extensible registry.
- `project_context_required` states whether valid output requires a discovered compilation or project partition.
- `excluded_construct_codes` is the complete set of registered construct classes the declaration never supports; empty means no static construct exclusion is declared.

`CapabilityLimitation` fields:

- `limitation_code` is the registered stable meaning of the limitation and its trigger.
- `applicable_language_ids`, `applicable_artifact_kinds`, and `applicable_construct_codes` form a conjunctive applicability selector; an empty set in one dimension means all values in that dimension.
- `resulting_status` is `partial`, `unknown`, or `unsupported`; `complete` is forbidden for a limitation.
- `description` is bounded human guidance and cannot add semantics absent from `limitation_code`.

The compatibility resolver uses `capability` and `capability_contract_version` as the hard requirement. It does not compare `precision` and `coverage` as a scalar level. These shapes are closed, participate in the contribution digest, and cannot be extended at runtime; behavioral rules remain owned by the language-plugin contract.

### Public query request

```text
QueryRequest
  api_version
  scope
  expression
  options

QueryScope = SingleWorkspaceScope | ComparisonScope

SingleWorkspaceScope
  scope_type = single_workspace
  workspace_id
  snapshot_id?

ComparisonScope
  scope_type = comparison
  participants[]

QueryParticipant
  workspace_id
  role
  snapshot_id?

QueryExpression = OperationExpression | PipelineExpression | RecipeExpression

OperationExpression
  expression_type = operation
  operation
  arguments

PipelineExpression
  expression_type = pipeline
  stages[]
  outputs[]

RecipeExpression
  expression_type = recipe
  recipe_id
  recipe_version?
  arguments

QueryStage
  stage_id
  operator
  inputs[]
  arguments

StageOutputReference
  stage_id
  output

DefinitionMatcher
  text
  mode
  definition_types[]
  namespaces[]
  limit

DefinitionSetReference
  stage_id
  output

QueryOptions
  freshness
  wait_timeout_ms
  coverage_requirement
  evidence
  diagnostics
  snippets
  registry
  response_budget

ResponseBudget
  max_items
  max_characters

ContinuationRequest
  api_version
  scope
  cursor
  response_budget

FindRecordsArguments
  selector

RecordStructuralSelector
  record_categories[]?
  kind_selector?
  producer_ids[]?
  filter?
```

Operation arguments use the approved `SubjectSelector` union, `StructuralFilter`, `RelationSelector`, `RegistrySelector`, and `ChangeDescriptor` union. Their complete discriminators, fields, presence rules, defaults, and interactions are defined in the [Public query contract](../protocol/public-query-contract.md); they are listed in this inventory so no public request model exists outside the universal model catalog. Operation-specific argument objects are closed schema instances keyed by their stable operation definition rather than additional canonical knowledge models.

`QueryRequest.api_version` is the exact supported public contract version. `scope` is mandatory and never inferred from transport state. `expression` selects exactly one stable operation, composed pipeline, or immutable recipe. `options` contains only projection, freshness, completeness, and response-budget controls; it cannot supply ranking weights or physical execution hints.

`SingleWorkspaceScope.workspace_id` is mandatory. `snapshot_id`, when present, selects one retained snapshot belonging to that workspace; when absent, the freshness policy resolves and pins one current snapshot. `ComparisonScope.participants` contains at least two entries in caller-significant order. Every participant has a non-empty operation-defined `role`; roles are unique and valid for the selected comparison expression. A workspace may appear in several roles only to compare different snapshots of that workspace; in that case every occurrence requires an explicit, distinct `snapshot_id`. Otherwise workspace IDs are unique. An optional `snapshot_id` follows the same retained-snapshot rule.

`OperationExpression.operation` is one stable core operation identifier. `arguments` is a closed typed value validated by that operation's API-version-pinned schema. `PipelineExpression.stages` is a non-empty topologically ordered list with unique stage IDs; `outputs` is a non-empty ordered set of valid stage outputs exposed to the result projector. `RecipeExpression.recipe_id` selects one core-owned recipe; omitted `recipe_version` resolves to the API version's immutable default before hashing, while an explicit version must be supported. Recipe `arguments` are closed by that exact version.

`QueryStage.operator` is one core-owned algebra operator. `inputs` contains only outputs from earlier stages and is empty exactly for a legal source stage. `arguments` is closed by the selected operator schema. `StageOutputReference.output` names a registered typed output of its stage; an invalid or type-incompatible edge rejects the plan before execution.

`DefinitionMatcher.text` is non-empty bounded UTF-8. `mode` is `exact`, `prefix`, `contains`, `semantic`, or `hybrid`; semantic modes classify matches as candidates rather than proof. `definition_types` and `namespaces` are optional filters represented by empty arrays for all values. `limit` is a positive server-bounded candidate limit that affects the normalized plan. `DefinitionSetReference` points to the typed definition-set output of an earlier registry stage and is legal wherever a selector accepts discovered definitions.

`QueryOptions.freshness` is `snapshot`, `current`, or `wait_for_current`. `snapshot` requires explicit snapshot IDs; `current` pins the latest published snapshots immediately; `wait_for_current` waits for equivalent freshness checkpoints. `wait_timeout_ms` is zero unless a wait-capable freshness or coverage requirement is selected and is bounded by server policy. `coverage_requirement` is `accept_reported` or `require_complete`; it applies to every capability used by the expression. `evidence` is `EvidenceIncludeOptions`, `diagnostics` is `DiagnosticIncludeOptions`, `snippets` is `SourceIncludeOptions`, and `registry` is `RegistryIncludeOptions` defaulting to `{registry: used, include_payload_schemas: false}`. `response_budget` is mandatory after default normalization.

`ResponseBudget.max_items` and `max_characters` are positive server-bounded limits. Both apply; the first limit reached ends hydration without altering total counts or result membership. `max_characters` uses the fixed compact-JSON counting convention defined by the API contract.

`ContinuationRequest` never contains the original expression. Its opaque `cursor` selects an already materialized execution stream. `scope` must repeat the original ordered workspace IDs, comparison roles, and explicit snapshot selectors exactly; `response_budget` may be smaller than the original budget but cannot change result projection, snippet mode, evidence mode, or membership. A cursor cannot be used to recompute an expired execution.

`FindRecordsArguments.selector` is required. `RecordStructuralSelector` has at least one present dimension. `record_categories` is an optional non-empty subset of `entity`, `relation`, `fact`, `evidence`, and `diagnostic`; values combine by OR. `kind_selector` uses the approved conjunctive `KindSelector`. `producer_ids` is an optional non-empty duplicate-free list of exact plugin or core producer identities and combines by OR. `filter` is the existing `StructuralFilter`; its dimensions combine with every other selector dimension by AND. The duplicated `filter.kind_selector`, when present beside top-level `kind_selector`, is also conjunctive. Present empty arrays and a selector with no dimensions are invalid.

### IntentRecipeDefinition

```text
IntentRecipeDefinition
  recipe_id
  recipe_version
  public_api_version
  description
  argument_schema_id
  argument_schema_version
  stages[]
  outputs[]
  required_capabilities[]
  completeness_policy
  ranking_bindings[]
  guards[]
  pagination_streams[]
  recipe_digest

IntentRecipeStageDefinition
  stage_id
  operator_id
  operator_version
  inputs[]
  static_arguments_schema_id
  static_arguments_schema_version
  static_arguments
  argument_bindings[]

RecipeArgumentBinding
  recipe_argument_path
  stage_argument_path

IntentRecipeOutputDefinition
  output_name
  stage_id
  stage_output
  projection

IntentRecipeRankingBinding
  stage_id
  ranking_profile_id
  ranking_profile_version

IntentRecipeGuardDefinition
  guard_id
  evaluation_point
  predicate_code
  failure_error_code

IntentRecipePaginationStream
  stream_name
  output_name
  ordering_id
  ordering_version
  classifications[]
```

`recipe_id + recipe_version` is the immutable core-owned identity and `public_api_version` is the first API contract selecting it. `description` is agent-facing bounded text. `argument_schema_id + argument_schema_version` select one closed recipe-argument schema. `stages` is a non-empty topologically ordered pipeline template; `outputs` is a non-empty agent-visible projection set. `required_capabilities` is the complete duplicate-free capability requirement set and `completeness_policy` is `report` or `require_complete`.

Each stage has a unique `stage_id`, exact core operator and version, backward-only typed input references, and one closed static argument value validated by its adjacent schema coordinate. A `RecipeArgumentBinding` copies the value at one RFC 6901 recipe argument pointer into one stage argument pointer before ordinary query normalization; pointers are unique by target and cannot escape their selected schemas. Static arguments and bound paths cannot overlap.

Every output has a unique stable `output_name`, names one stage output, and selects `subjects`, `relations`, `paths`, `definitions`, or that operation's exact named projection. Ranking bindings are present only for stages whose stable operation produces ranked candidates; they select immutable core ranking profiles and are never returned to agents. Guards use registered closed `predicate_code` and `failure_error_code` values at `before_stage`, `after_stage`, or `before_manifest` and cannot execute plugin logic. Pagination streams have unique names, reference one output, pin an immutable ordering contract, and state their independently paged result classifications; an empty classification list means one unclassified stream.

`recipe_digest` commits to every preceding field in declared order. Recipes cannot be supplied by plugins. The exact initial definitions, argument schemas, stages, guards, outputs, and paging streams are the [core intent recipe registry](../protocol/core-intent-recipes.md).

### QueryExecution

A composed query creates a persistent, snapshot-pinned execution:

```text
QueryExecution
  query_execution_id
  scope_kind
  workspace_snapshot_bindings[]
  semantic_index_bindings[]
  query_plan_hash
  capability_versions
  ordered_result_manifest
  execution_status
  created_at
  expires_at
```

```text
WorkspaceSnapshotBinding
  workspace_snapshot_binding_id
  participant_ordinal
  participant_role?
  workspace_id
  snapshot_id
  generation
  registry_snapshot_id
  resolution_lock_id
  configuration_revision_id
  freshness_checkpoint_id
  retention_lease_id
```

- `QueryExecution.query_execution_id` identifies one persistent logical execution and all of its result, evidence, diagnostic, and registry continuation streams.
- `QueryExecution.scope_kind` is `single_workspace` or `comparison`. A single-workspace execution has exactly one binding; a comparison has at least two.
- `QueryExecution.workspace_snapshot_bindings` is a non-empty ordered set preserving normalized request participant order. Every participant role and exact workspace-snapshot coordinate occurs exactly once. The same workspace may occur under different roles only with distinct explicit snapshots. Acquisition of all bindings and leases is atomic.
- `QueryExecution.semantic_index_bindings` is the complete ordered set of semantic retrieval lanes pinned by the plan. It is empty when the query has no semantic stage.
- `QueryExecution.query_plan_hash` identifies the complete normalized operation, stages, selectors, budgets that affect result membership or ordering, and recipe version.
- `QueryExecution.capability_versions` pins every capability, semantic model, and ranking contract used by the plan, keyed by binding where versions differ.
- `QueryExecution.ordered_result_manifest` identifies the immutable persisted result manifest hydrated by pagination.
- `QueryExecution.execution_status` is `materializing`, `ready`, `expired`, or `failed`; only `ready` executions issue cursors.
- `QueryExecution.created_at` and `expires_at` define the execution lifetime. Expiration atomically makes every cursor unusable and releases every binding lease.

`WorkspaceSnapshotBinding` fields:

- `workspace_snapshot_binding_id` identifies one immutable participant binding within the execution.
- `participant_ordinal` is zero-based and contiguous. `participant_role` is an optional operation-defined stable role such as `base` or `target`; when a comparison contract declares roles, it is required and unique under that contract.
- `workspace_id` is the explicit workspace selected by the request.
- `snapshot_id` and `generation` identify its exact immutable code state.
- `registry_snapshot_id`, `resolution_lock_id`, and `configuration_revision_id` pin the exact definitions, plugins, analyzers, and configuration used to plan and interpret that workspace.
- `freshness_checkpoint_id` pins the exact freshness assessment observed at execution start. Later observations never change the execution's completeness report.
- `retention_lease_id` identifies the lease acquired for this exact snapshot. Every binding has one lease, and failure to acquire any lease rejects the complete execution without retaining a partial comparison scope.

The execution is control-plane data, not source-derived knowledge. No workspace, snapshot, registry, freshness checkpoint, or lease is inferred from transport connection state.

### Semantic query execution values

Indexed source vectors and query vectors have different ownership domains. A query vector is ephemeral execution state and never receives a fictitious artifact owner:

```text
QueryEmbedding
  query_embedding_id
  query_execution_id
  semantic_lane_id
  embedding_profile_id
  embedding_profile_digest
  executable_binding_digest
  generator
  generator_version
  generator_configuration_digest
  embedding_input
  embedding_input_digest
  token_count
  dimensions
  element_type
  vector_encoding
  normalization
  vector_bytes
  vector_digest
  created_at
  query_embedding_digest

SemanticIndexBinding
  semantic_index_binding_id
  semantic_lane_id
  workspace_snapshot_binding_id
  semantic_index_materialization_id
  embedding_profile_id
  embedding_profile_digest
  executable_binding_digest
  generator
  generator_version
  generator_configuration_digest
  queryable_vector_set_digest
  binding_digest
```

`QueryEmbedding` fields:

| Field | Exact meaning |
|---|---|
| `query_embedding_id` | Ephemeral identity of one rendered query vector. |
| `query_execution_id` | Execution whose semantic stage requested it. |
| `semantic_lane_id` | One normalized vector-retrieval lane inside the query plan. |
| `embedding_profile_id`, `embedding_profile_digest` | Exact profile and definition used for rendering and encoding. |
| `executable_binding_digest` | Exact locally executable profile realization; it must equal every materialization in the lane. |
| `generator`, `generator_version`, `generator_configuration_digest` | Exact generator and model-pack runtime-configuration lock equal to every materialization and vector in the lane. |
| `embedding_input` | Exact rendered query text supplied to the model. |
| `embedding_input_digest` | Digest of the exact UTF-8 input bytes. |
| `token_count` | Exact tokenizer count, no greater than the profile's query limit. |
| `dimensions`, `element_type`, `vector_encoding`, `normalization` | Repeated profile values validated against the generated bytes. |
| `vector_bytes`, `vector_digest` | Exact ephemeral encoded vector and byte digest. |
| `created_at` | Informational creation timestamp. |
| `query_embedding_digest` | UCE digest governed by `core:query_embedding_digest`; its positive binding omits identifiers, raw duplicate vector bytes, and creation time while including `vector_digest`. |

`SemanticIndexBinding` fields:

| Field | Exact meaning |
|---|---|
| `semantic_index_binding_id` | Immutable binding identity within one query execution. |
| `semantic_lane_id` | Vector lane using one profile and generator lock. |
| `workspace_snapshot_binding_id` | Exact code-snapshot participant searched by this binding. |
| `semantic_index_materialization_id` | Exact semantic materialization searched. |
| `embedding_profile_id`, `embedding_profile_digest` | Exact immutable vector-space definition. |
| `executable_binding_digest` | Exact locally executable profile realization copied from the materialization and query embedding. |
| `generator`, `generator_version`, `generator_configuration_digest` | Exact generator and model-pack runtime-configuration lock used for both indexed and query vectors. |
| `queryable_vector_set_digest` | Exact searched vector set copied from the materialization. |
| `binding_digest` | UCE digest governed by `core:semantic_index_binding_digest` and its explicit positive payload binding. |

One lane has exactly one profile, executable binding, generator, and vector space. Normal query requests do not select profiles or runtime builds. The core derives the complete lane set from the active executable bindings in every pinned workspace configuration plus the operation's indexed-language, content-class, and typed query-class requirements. Installed inactive profiles are absent. A composed query may use several lanes for different or overlapping language and content coverage. Raw similarity scores from different lanes are never compared directly; later rank fusion operates on independently ranked lists.

Every selected lane participates independently in semantic completeness. Coverage by another vector space does not erase a pending, failed, unsupported, or unavailable state in a selected lane. `QueryExecution.semantic_index_bindings` freezes the complete ordered set before retrieval; later activation or progress cannot alter it or any continuation page.

Once the ordered result manifest is ready, `QueryEmbedding` may be destroyed without affecting continuation pages. Profile, bindings, completeness, and exact result order remain in `QueryExecution`. Retention of raw query inputs and vectors may be shorter than execution retention under local privacy policy.

### ResultManifestEntry

The query cache stores compact ordered references rather than complete rendered responses:

```text
ResultManifestEntry
  query_execution_id
  ordinal
  result_set
  primary_result
  evidence_path_record_ids[]
  result_classification
  rank
  stage_id
  source_projection
  stable_sort_key
```

Exact physical representation and hydration behavior remain owned by the storage specification.

`ResultManifestEntry.result_set` is the stable selected output name from the normalized expression. Together with `result_classification` it selects one independent manifest stream; `ordinal` is zero-based and contiguous only inside that pair. This prevents callers, tests, implementations, or another selected set from losing their role. `primary_result` is always the compact `ResultSubject` reference defined below. It never embeds a canonical record or artifact body; page hydration converts it to the corresponding `PrimaryResultView` without changing the subject coordinates.

```text
ResultSubject =
  EntityResultSubject |
  RecordResultSubject |
  ArtifactResultSubject

EntityResultSubject
  result_type = entity
  workspace_snapshot_binding_id
  entity_id
  entity_record_id

RecordResultSubject
  result_type = record
  workspace_snapshot_binding_id
  record_id

ArtifactResultSubject
  result_type = artifact
  workspace_snapshot_binding_id
  artifact_id
  artifact_version_id

PrimaryResultView =
  EntityPrimaryResultView |
  RecordPrimaryResultView |
  ArtifactPrimaryResultView

EntityPrimaryResultView
  result_type = entity
  subject
  record

RecordPrimaryResultView
  result_type = record
  subject
  record

ArtifactPrimaryResultView
  result_type = artifact
  subject
  artifact
  artifact_version
```

`result_type` is the required discriminator. `workspace_snapshot_binding_id` is mandatory in every variant and selects the exact execution participant. An entity result always pins both its lifecycle identity and exact visible record version. A record result identifies an exact canonical entity, relation, fact, evidence, or diagnostic record. An artifact result identifies an exact artifact occurrence and is used for physical files or virtual sources that must not be invented as entities.

`PrimaryResultView` is the hydrated response counterpart of the compact `ResultSubject`. Every variant repeats the same `result_type`; its `subject` is the exact corresponding subject value. `EntityPrimaryResultView.record` is the complete visible `EntityRecord` whose `record_id` equals `subject.entity_record_id` and whose `entity_id` equals `subject.entity_id`. `RecordPrimaryResultView.record` is the complete concrete canonical record whose `record_id` equals `subject.record_id`. `ArtifactPrimaryResultView.artifact` and `artifact_version` are the complete selected `SourceArtifact` and `ArtifactVersion`; both IDs and workspace must equal the subject, and the version must belong to the artifact. Hydration is always from the subject's pinned workspace binding and cannot substitute a newer occurrence.

### ResultBundle

Pagination returns self-contained bundles rather than isolated graph rows:

```text
ResultBundle
  result_set
  primary_result
  assessment
  provenance_path
  essential_related_entities[]
  optional_source_snippets[]
```

Each bundle preserves enough evidence and context to be understood independently. `result_set` is the stable selected output name declared by an operation, pipeline `select`, or recipe. `assessment` is the approved `ResultAssessment`, which keeps classification, confidence, evidence, and relevant completeness semantics together.

- `primary_result` is the exact `PrimaryResultView` hydrated from the compact manifest subject selected by the query stage.
- `assessment` is the required `ResultAssessment` explaining classification, uncertainty, evidence, and relevant completeness.
- `provenance_path` is the ordered, typed path of query stages and canonical records through which the primary entity reached the result set.
- `essential_related_entities` contains the minimal `EntityPrimaryResultView` values required to interpret that path independently; optional expansions are excluded.
- `optional_source_snippets` contains only explicitly requested, budgeted `SourceSnippet` values from pinned artifact versions.

### CursorTokenClaims

Cursor tokens are opaque database locators to clients. Their authoritative persisted claims are:

```text
CursorTokenClaims = QueryCursorTokenClaims | IndexStatusCursorTokenClaims

QueryCursorTokenClaims
  cursor_kind = query
  query_execution_id
  workspace_scope_digest
  result_stream
  stable_position
  direction
  projection_digest
  response_budget_ceiling_digest
  expires_at

IndexStatusCursorTokenClaims
  cursor_kind = index_status
  index_status_execution_id
  workspace_status_scope_digest
  result_stream
  stable_position
  direction
  projection_digest
  response_budget_ceiling_digest
  expires_at
```

Both variants carry an execution-owned `result_stream`, stable position, forward or backward direction, projection digest, normalized initial response-budget ceiling digest, and expiry. `QueryCursorTokenClaims.workspace_scope_digest` covers the complete ordered `WorkspaceSnapshotBinding` set, including participant roles, snapshot, registry, resolution lock, configuration, freshness checkpoint, and lease coordinates. Its stream is one exact result-set/classification pair, semantic affected artifacts, evidence, diagnostics, used registry definitions, or full registry definitions. `IndexStatusCursorTokenClaims.workspace_status_scope_digest` covers the exact ordered requested workspace IDs, include flags, observed time, and three frozen status-set descriptors. Its stream is workspace summaries, activation issues, or candidate issues.

The relevant continuation request repeats and validates the original source scope. Query and status cursor kinds are disjoint and cannot cross wrappers. `stable_position` is interpreted only under the selected stream and `projection_digest`. The externally returned cursor is an unguessable opaque identity resolved through the protected local catalog; no signing-key model is required. The initial normalized `ResponseBudget` is the ceiling. Each continuation component must be less than or equal to that ceiling; reducing one page never lowers the persisted ceiling, so a later continuation may again request any value up to the original. Urdira persists execution and claims, not source data in the token.

### QueryResultPage

The authoritative page model is:

```text
SemanticCoverageView
  semantic_index_binding_id
  materialization_state
  artifact_count
  covered_artifact_count
  pending_artifact_count
  excluded_artifact_count
  unsupported_artifact_count
  failed_artifact_count
  affected_artifact_set_id?
  affected_artifact_count
  affected_artifact_page?

SemanticAffectedArtifactView
  artifact_id
  artifact_version_id
  display_path
  coverage_status
  reason_codes[]
  diagnostic_record_ids[]

SemanticAffectedArtifactPage
  affected_artifact_set_id
  artifacts[]
  total
  next_cursor?
  previous_cursor?
  has_next
  has_previous

QueryResultPage
  query_execution_id
  scope_kind
  workspace_snapshot_bindings[]
  semantic_coverage_views[]
  result_sets[]
  expires_at
  returned_items
  returned_characters
  estimated_tokens?
  completeness_report
  diagnostic_report
  registry_bundle?

ResultStreamPage
  classification
  page_mode
  result_bundles[]
  total
  next_cursor?
  previous_cursor?
  has_next
  has_previous

ResultSetPage
  result_set
  confirmed
  possible
```

`SemanticCoverageView` fields:

- `semantic_index_binding_id` selects the exact semantic lane, workspace binding, and materialization described.
- `materialization_state` repeats `complete`, `updating`, `degraded`, or `unavailable` from the pinned materialization.
- The six artifact-count fields repeat the exact immutable materialization counts so the response is self-contained.
- `affected_artifact_count` is the exact sum of pending, unsupported, and failed entries. Explicitly excluded artifacts are reported separately and are not affected gaps.
- `affected_artifact_set_id` and `affected_artifact_page` are both omitted when the affected count is zero and both required otherwise. The page is the complete set when it fits or the first bounded page when it does not.

`SemanticAffectedArtifactView` fields:

- `artifact_id` and `artifact_version_id` identify the exact affected occurrence.
- `display_path` is the snapshot-pinned agent-readable artifact address.
- `coverage_status` is `pending`, `unsupported`, or `failed` in this view.
- `reason_codes` contains the registered exact causes.
- `diagnostic_record_ids` contains query-relevant source diagnostics and is empty for an ordinary pending update.

`SemanticAffectedArtifactPage` fields:

- `affected_artifact_set_id` identifies one immutable set owned by the query execution.
- `artifacts` contains the current bounded page in deterministic artifact-address and artifact-ID order.
- `total` equals `SemanticCoverageView.affected_artifact_count`.
- `next_cursor` and `previous_cursor` are present exactly when their corresponding boolean is true and continue only this affected-artifact stream.

Every query using a semantic lane returns its coverage view even when coverage is complete. While embeddings are updating, the `CompletenessReport` contains capability `core:semantic_retrieval`, status `partial`, and the registered updating reason. This lets an agent distinguish no matches from a non-exhaustive semantic candidate set. Coverage views, counts, pages, and cursors remain snapshot- and execution-pinned across every result continuation.

`QueryResultPage` fields:

- `query_execution_id` identifies the persisted, snapshot-pinned logical execution used by every result and evidence cursor.
- `scope_kind` repeats the execution's `single_workspace` or `comparison` discriminator.
- `workspace_snapshot_bindings` repeats the complete immutable binding set, including snapshot, registry, resolution lock, configuration, freshness checkpoint, and lease identity for every participant. Every continuation page repeats the same values.
- `semantic_coverage_views` contains exactly one compact view for every semantic index binding and is empty for a query without semantic retrieval.
- `result_sets` is a non-empty list in normalized selected-output order. Every entry contains independent confirmed and possible `ResultStreamPage` values for one stable selected output.
- `expires_at` is the timestamp after which continuation is no longer guaranteed because the cached execution may be collected.
- `returned_items` is the total number of result bundles hydrated across every result-set/classification stream in this response.
- `returned_characters` is the enforceable count charged to the page's serialized-character budget under the public API's one fixed compact-JSON escaping and counting convention; transport framing is excluded.
- `estimated_tokens` is an optional informational estimate and is never used to enforce the budget.
- `completeness_report` is the approved `CompletenessReport` for the full logical execution and remains stable across all its pages.
- `diagnostic_report` is always present. A no-detail mode may omit diagnostic bodies but retains exact totals and aggregates for the full execution.
- `registry_bundle` is absent exactly for registry mode `none` and required for `used` or `full`. A used bundle carries its page-specific `registry_usage_set_id`; a full bundle continues the complete selected registry. Registry pagination is independent from every result, evidence, diagnostic, and semantic-coverage stream.

`ResultStreamPage` fields:

- `classification` is fixed by its parent key inside `ResultSetPage`: `confirmed` for the confirmed stream and `possible` for the possible stream.
- `page_mode` is `hydrated` or `summary`. An initial query normally hydrates every result-set/classification stream under deterministic independent sub-budgets. A continuation hydrates only the stream selected by its cursor; every other required stream is returned in `summary` mode.
- `result_bundles` contains the self-contained bundles hydrated for this stream in the current response. It is empty exactly in `summary` mode or when a hydrated slice is validly empty.
- `total` is the total number of manifest entries in this stream, not the number returned on the current page.
- `next_cursor` continues this stream forward and is present exactly when `has_next` is true. In `summary` mode it starts at the first bundle rather than skipping one.
- `previous_cursor` continues this stream backward and is present exactly when `has_previous` is true.
- `has_next` states whether later bundles remain in this stream.
- `has_previous` states whether earlier bundles exist in this stream relative to the current page.

`ResultSetPage.result_set` is one selected output name from the normalized expression. `confirmed` and `possible` are both mandatory even when one total is zero, so one class can never hide the existence of the other.

The response-size budget is enforced through deterministic item and serialized-character limits. Token estimates are informational. Every result set has independent confirmed and possible cursor-addressable streams, so a large callers set cannot force an agent to paginate through it before reaching tests or another selected output.

A cursor continuation selects exactly one stream and one adjacent slice; Urdira keeps no hidden per-client position for other streams. Non-selected result streams repeat their immutable totals in `summary` mode with `has_previous: false`, no `previous_cursor`, and `has_next + next_cursor` present exactly when `total > 0`. Pages reached through a backward cursor are still rendered in the stream's canonical forward order; cursor direction chooses the adjacent slice and never reverses bundle order.

### Index status execution and pages

```text
IndexStatusRequest = IndexStatusInitialRequest | IndexStatusContinuationRequest

IndexStatusInitialRequest
  request_type = initial
  api_version
  workspace_ids[]
  include_capabilities
  include_plugins
  include_activation_issues
  include_candidate_issues
  response_budget

IndexStatusContinuationRequest
  request_type = continuation
  api_version
  workspace_ids[]
  cursor
  response_budget

IndexStatusExecution
  index_status_execution_id
  workspace_ids[]
  include_capabilities
  include_plugins
  include_activation_issues
  include_candidate_issues
  workspace_status_set
  activation_issue_status_set
  candidate_issue_status_set
  response_budget_ceiling
  projection_digest
  execution_status
  observed_at
  created_at
  expires_at

IndexStatusPage
  index_status_execution_id
  workspace_ids[]
  workspaces
  activation_issues
  candidate_issues
  observed_at
  expires_at
  returned_items
  returned_characters

WorkspaceStatusStreamPage
  workspaces[]
  total
  next_cursor?
  previous_cursor?
  has_next
  has_previous

WorkspaceIndexStatusView
  workspace_id
  display_root
  workspace_status
  startup_phase
  current_snapshot_id?
  current_generation?
  freshness_checkpoint_id?
  freshness_status
  current_candidate?
  active_registry_snapshot_id?
  active_resolution_lock_id?
  plugins[]
  capabilities[]
  semantic_materializations[]
  latest_activation_attempt?

IndexCandidateStatusView
  candidate_generation_id
  trigger_kind
  state
  base_snapshot_id?
  target_registry_snapshot_id
  target_configuration_revision_id
  issue_count
  created_at
  analysis_started_at?
  ready_at?

WorkspacePluginStatusView
  plugin_id
  plugin_version
  activation_status
  capability_declarations[]

WorkspaceCapabilityStatusView
  capability
  capability_contract_version
  provider_id
  provider_version
  status
  reason_codes[]
  affected_artifact_count

SemanticMaterializationStatusView
  semantic_materialization_id
  embedding_profile_id
  source_snapshot_id
  materialization_state
  coverage_status
  pending_document_count
  pending_segment_count

ActivationAttemptStatusView
  activation_attempt_id
  state
  phase
  candidate_generation_id?
  published_snapshot_id?
  issue_count
  started_at
  finished_at?

ActivationIssueStatusView
  issue_id
  code
  severity
  phase
  plugin_ids[]
  summary
  required_action
  retryable
  created_at

CandidateIssueStatusView
  candidate_issue_id
  candidate_generation_id
  issue_code
  phase
  severity
  scope
  retryability
  summary
  created_at

ActivationIssueStatusStreamPage
  issues[]
  total
  next_cursor?
  previous_cursor?
  has_next
  has_previous

CandidateIssueStatusStreamPage
  issues[]
  total
  next_cursor?
  previous_cursor?
  has_next
  has_previous
```

The initial request always carries `workspace_ids`; an empty array is the explicit global-discovery scope. A non-empty array forbids duplicates and preserves caller order; global discovery orders by `workspace_id`. A continuation repeats the exact same array. The four include flags are normalized into the execution and omitted from continuation because the cursor pins them. `execution_status` is `materializing`, `ready`, `expired`, or `failed`; only `ready` issues cursors.

Creation of a ready execution materializes all three complete ordered safe-view sets and freezes `observed_at`, selection flags, projection, budget ceiling, membership, totals, and order. Later workspace, candidate, activation, plugin, capability, or semantic state changes cannot alter them. These execution-owned views are retention roots until expiry and require no source snapshot lease. Status pagination never rereads mutable control rows.

`workspaces`, `activation_issues`, and `candidate_issues` on `IndexStatusPage` are respectively `WorkspaceStatusStreamPage`, `ActivationIssueStatusStreamPage`, and `CandidateIssueStatusStreamPage`. The three streams are independent and always expose totals; include-false produces an exact empty issue or optional-detail set rather than hiding another stream. Response-budget continuations follow the same component-wise ceiling rule as query continuations.

`WorkspaceIndexStatusView.current_candidate`, `plugins`, `capabilities`, `semantic_materializations`, and `latest_activation_attempt` use exactly the corresponding closed view types above. `startup_phase` is `not_started`, `opening_storage`, `recovering`, `reconciling_sources`, `starting_workers`, `ready`, or `failed`. `freshness_status` is `equivalent`, `changes_pending`, or `degraded`. Plugin activation is `active`, `quarantined`, or `unavailable`; capability status is `complete`, `partial`, `unknown`, or `unsupported`; semantic materialization and coverage reuse their canonical enums. Candidate and activation view enums and timestamp presence reuse their source control models.

Issue views are bounded safe projections. They omit plugin-supplied opaque payloads, unbounded detail, absolute storage paths, and package paths. Activation pages contain only `ActivationIssueStatusView`; candidate pages contain only `CandidateIssueStatusView`. Their cursors are `IndexStatusCursorTokenClaims` and are rejected by query continuation.

## Resolved serialization decision

Deterministic representation, Schema IR, logical scalar and collection encoding, digest framing, computed-versus-referenced digest contracts, integrity behavior, and cross-language conformance are approved in [Urdira Canonical Encoding](../serialization/urdira-canonical-encoding.md). Every current core digest field is assigned in the [core digest field-contract registry](../serialization/core-digest-field-contracts.md).

## Approval record

This specification is approved because:

- Every canonical record category and invariant has an unambiguous schema.
- File ownership and cross-file invalidation can be expressed without exceptions in the knowledge plane.
- Identity and temporal behavior are defined for files, entities, and relations.
- Plugin extensions can be validated without changing the core schema.
- Derived projections can be rebuilt from canonical records.
- Semantic documents, segments, vectors, materializations, and query bindings retain exact ownership and deterministic profile identity without becoming canonical truth.
- Representative examples from at least JavaScript/TypeScript and one structurally different language fit the model.

### Owner migration lifecycle

Core treats movement of an entity, relation, or diagnostic to a different
owner artifact as a lifecycle boundary, including when the old owner is
outside the replacement scope. The old occurrence closes as replaced; the
replacement record is `digest({record, previous_record_id})` and receives a
new identity salted by `owner_migration_barrier` derived from the old identity.
Facts and evidence do not participate in this migration rule.
