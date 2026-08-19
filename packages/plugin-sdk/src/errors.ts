export type PluginSdkErrorCode =
  | "plugin-sdk:canonical_value_invalid"
  | "plugin-sdk:package_declaration_invalid"
  | "plugin-sdk:package_coordinate_mismatch"
  | "plugin-sdk:package_digest_mismatch"
  | "plugin-sdk:package_discovery_failed"
  | "plugin-sdk:package_file_too_large"
  | "plugin-sdk:version_invalid"
  | "plugin-sdk:version_requirement_invalid"
  | "plugin-sdk:resolution_failed"
  | "plugin-sdk:registry_contribution_invalid"
  | "plugin-sdk:analysis_view_invalid"
  | "plugin-sdk:resource_budget_invalid"
  | "plugin-sdk:cancelled"
  | "plugin-sdk:context_budget_exhausted"
  | "plugin-sdk:content_unavailable"
  | "plugin-sdk:dependency_closure_unavailable"
  | "plugin-sdk:lookup_binding_invalid"
  | "plugin-sdk:lookup_scope_unauthorized"
  | "plugin-sdk:lookup_revalidation_invalid"
  | "plugin-sdk:port_failure"
  | "plugin-sdk:worker_protocol_invalid"
  | "plugin-sdk:request_identity_conflict"
  | "plugin-sdk:worker_lost"
  | "plugin-sdk:worker_quarantined"
  | "plugin-sdk:worker_resource_exhausted"
  | "plugin-sdk:worker_failed"
  | "plugin-sdk:sandbox_unsupported";

export type PluginSdkErrorDetail = null | boolean | number | string | readonly PluginSdkErrorDetail[] | { readonly [key: string]: PluginSdkErrorDetail };

const MAX_MESSAGE_LENGTH = 240;

function safeMessage(code: PluginSdkErrorCode, message: string): string {
  const bounded = message.replace(/[\r\n\t]/gu, " ").slice(0, MAX_MESSAGE_LENGTH);
  return bounded.startsWith("plugin-sdk:") ? bounded : `${code} ${bounded}`;
}

export class PluginSdkError extends Error {
  readonly code: PluginSdkErrorCode;
  readonly details: PluginSdkErrorDetail;

  constructor(code: PluginSdkErrorCode, message: string, details: PluginSdkErrorDetail = null) {
    super(safeMessage(code, message));
    this.name = "PluginSdkError";
    this.code = code;
    this.details = details;
  }

  toJSON(): { readonly code: PluginSdkErrorCode; readonly message: string; readonly details: PluginSdkErrorDetail } {
    return { code: this.code, message: this.message, details: this.details };
  }
}

export function sdkError(code: PluginSdkErrorCode, message: string, details: PluginSdkErrorDetail = null): PluginSdkError {
  return new PluginSdkError(code, message, details);
}
