export { DaemonError, type DaemonErrorCode } from "./errors.js";
export {
  UCE_DEFAULT_MAX_FRAME_BYTES,
  UCE_PROTOCOL_VERSION,
  LengthPrefixedDecoder,
  LocalIpcClient,
  LocalIpcServer,
  decodeUceFrame,
  encodeUceFrame,
  type LocalIpcClientOptions,
  type LocalIpcRequestOptions,
  type LocalIpcServerOptions,
  type UceFrame,
  type UceProgress,
  type UceRequest,
  type UceRequestContext,
  type UceRequestHandler,
  type UceResponse,
} from "./protocol.js";
export { EndpointDescriptorStore, LastKnownGoodStore, ProcessLock, daemonPaths, type DaemonPaths, type EndpointDescriptor, type LastKnownGood } from "./ownership.js";
export { DaemonScheduler, PersistentCursorRecovery, WORK_POOL_KINDS, type ClientQuota, type JobHandle, type PersistedCursorState, type ProgressEvent, type ReadOnlySourcePort, type RestartLease, type SchedulerJobRequest, type SchedulerOptions, type WorkPoolKind } from "./scheduler.js";
export { DaemonClient, DaemonRuntime, type DaemonPluginCatalogEntry, type DaemonRuntimeOptions, type DaemonStatus } from "./runtime.js";
export { createPersistentWorkspaceRegistry, WorkspaceRegistry, type WorkspaceRegistryState } from "./workspace-registry.js";
export { runLexicalReconcileInThread, type LexicalThreadJob, type LexicalThreadRun } from "./lexical-thread.js";
export { buildSemanticProvider, ensureSemanticAssets, type SemanticModelProvisioningNotice, type SemanticProviderDescriptor } from "./semantic-provider-runtime.js";
export { runSemanticReconcileInProcess, runSemanticReconcileInThread, startNeuralSemanticProviderHost, type SemanticProcessJob, type SemanticProcessRun, type SemanticThreadJob, type SemanticThreadRun, type NeuralSemanticProviderHost } from "./semantic-process.js";
