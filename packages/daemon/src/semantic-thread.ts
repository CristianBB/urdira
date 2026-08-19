/** @deprecated Use the process-isolated semantic transport from semantic-process.ts. */
export { runSemanticReconcileInProcess as runSemanticReconcileInThread } from "./semantic-process.js";
export type { SemanticProcessJob as SemanticThreadJob, SemanticProcessRun as SemanticThreadRun } from "./semantic-process.js";
