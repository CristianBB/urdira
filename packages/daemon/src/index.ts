export { DaemonError, type DaemonErrorCode } from "./errors.js";
export {
  IPC_DEFAULT_MAX_FRAME_BYTES,
  IPC_MAX_CHUNK_BYTES,
  IPC_PROTOCOL_VERSION,
  LengthPrefixedDecoder,
  LocalIpcClient,
  LocalIpcServer,
  normalizeLocalIpcEndpoint,
  decodeIpcFrame,
  encodeIpcFrame,
  encodeSourceBytesChunk,
  encodeFactDeltaChunk,
  decodeProcessByteChunk,
  type LocalIpcClientOptions,
  type LocalIpcRequestOptions,
  type LocalIpcServerOptions,
  type IpcFrame,
  type IpcProgress,
  type IpcRequest,
  type IpcRequestContext,
  type IpcRequestHandler,
  type IpcResponse,
  type ProcessByteChunk,
  type SourceBytesChunk,
  type FactDeltaChunk,
} from "./protocol.js";
export { EndpointDescriptorStore, LastKnownGoodStore, ProcessLock, daemonPaths, type DaemonPaths, type EndpointDescriptor, type LastKnownGood } from "./ownership.js";
export { DaemonScheduler, PersistentCursorRecovery, WORK_POOL_KINDS, type ClientQuota, type JobHandle, type PersistedCursorState, type ProgressEvent, type ReadOnlySourcePort, type RestartLease, type SchedulerJobRequest, type SchedulerOptions, type WorkPoolKind } from "./scheduler.js";
export { DaemonClient, DaemonRuntime, type DaemonPluginCatalogEntry, type DaemonRuntimeOptions, type DaemonStartupPhase, type DaemonStatus } from "./runtime.js";
export { createPersistentWorkspaceRegistry, WorkspaceRegistry, type WorkspaceRegistryState } from "./workspace-registry.js";
export { runLexicalReconcileInThread, type LexicalThreadJob, type LexicalThreadRun } from "./lexical-thread.js";
export { buildSemanticProvider, ensureSemanticAssets, type SemanticModelProvisioningNotice, type SemanticProviderDescriptor } from "./semantic-provider-runtime.js";
export { runSemanticReconcileInProcess, runSemanticReconcileInThread, startNeuralSemanticProviderHost, type SemanticProcessJob, type SemanticProcessRun, type SemanticThreadJob, type SemanticThreadRun, type NeuralSemanticProviderHost } from "./semantic-process.js";
