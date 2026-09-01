import { WORKSPACE_SCHEMA, WORKSPACE_V3_SCHEMA_DIGEST as GENERATED_WORKSPACE_V3_SCHEMA_DIGEST } from "./workspace-v3-sql.generated.js";

/**
 * Single digest authority for the v3 workspace schema. Rust embeds this
 * digest and refuses a workspace whose schema authority differs, preventing
 * handwritten SQL in the composition worker from silently drifting from the
 * TypeScript storage contract.
 */
export const WORKSPACE_V3_SCHEMA = WORKSPACE_SCHEMA;
export const WORKSPACE_V3_SCHEMA_DIGEST = GENERATED_WORKSPACE_V3_SCHEMA_DIGEST;

export function assertWorkspaceV3SchemaDigest(actual: string): void {
  if (actual !== WORKSPACE_V3_SCHEMA_DIGEST) throw new Error(`Workspace schema digest mismatch: expected ${WORKSPACE_V3_SCHEMA_DIGEST}, got ${actual}.`);
}
