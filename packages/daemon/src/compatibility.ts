/** Version of the private CLI/MCP-to-daemon RPC surface. */
export const DAEMON_PRIVATE_INTERFACE_VERSION = 2;

const CORE_RPC_CAPABILITIES = [
  "core:configuration_set",
  "core:daemon_restart",
  "core:daemon_start",
  "core:daemon_stop",
  "core:garbage_collect",
  "core:index_pack_export",
  "core:index_status",
  "core:query",
  "core:query_continue",
  "core:reindex",
  "core:repair",
  "core:status",
  "core:workspace_preview",
] as const;

const WORKSPACE_RPC_CAPABILITIES = [
  "core:codebase_assign",
  "core:codebase_create",
  "core:codebase_list",
  "core:codebase_remove",
  "core:codebase_rename",
  "core:codebase_unassign",
  "core:workspace_add",
  "core:workspace_admin_list",
  "core:workspace_admin_show",
  "core:workspace_configure",
  "core:workspace_purge",
  "core:workspace_remove",
] as const;

export function daemonRpcCapabilities(workspaceAdministration: boolean): readonly string[] {
  return [...CORE_RPC_CAPABILITIES, ...(workspaceAdministration ? WORKSPACE_RPC_CAPABILITIES : [])].sort();
}
