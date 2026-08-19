export type SecurityIssueCode =
  | "security:configuration_authority_narrowed"
  | "security:configuration_invalid"
  | "security:configuration_unknown_field"
  | "security:configuration_duplicate_key"
  | "security:configuration_unsupported_schema"
  | "security:path_outside_workspace"
  | "security:path_invalid"
  | "security:symlink_cycle"
  | "security:mandatory_exclusion"
  | "security:external_root_forbidden"
  | "security:ipc_permissions_unsafe"
  | "security:package_path_invalid"
  | "security:package_manifest_invalid"
  | "security:package_plugin_id_invalid"
  | "security:package_version_invalid"
  | "security:package_extra_file"
  | "security:package_coordinate_collision"
  | "security:package_activation_invalid"
  | "security:package_duplicate_path"
  | "security:package_digest_mismatch"
  | "security:package_length_mismatch"
  | "security:model_asset_length_mismatch"
  | "security:model_asset_digest_mismatch"
  | "security:model_undeclared_asset"
  | "security:model_manifest_digest_mismatch"
  | "security:model_manifest_invalid"
  | "security:model_manifest_unknown_field"
  | "security:model_runtime_role_duplicate"
  | "security:model_runtime_role_invalid"
  | "security:model_runtime_configuration_missing"
  | "security:model_runtime_configuration_invalid"
  | "security:model_semantic_role_invalid"
  | "security:model_media_type_forbidden"
  | "security:model_media_type_invalid"
  | "security:model_template_invalid"
  | "security:model_closure_reference_missing"
  | "security:model_closure_reference_invalid"
  | "security:model_closure_cycle"
  | "security:model_activation_invalid"
  | "security:model_coordinate_collision"
  | "security:model_profile_collision"
  | "security:staging_recovery_required"
  | "security:download_scheme_forbidden"
  | "security:download_redirect_forbidden"
  | "security:download_time_exceeded"
  | "security:download_cancelled"
  | "security:download_concurrency_exceeded"
  | "security:download_digest_mismatch"
  | "security:download_limit_exceeded";

export class SecurityError extends Error {
  readonly code: SecurityIssueCode;
  readonly details: Readonly<Record<string, string | number | boolean>>;

  constructor(code: SecurityIssueCode, message: string, details: Readonly<Record<string, string | number | boolean>> = {}) {
    super(`${code}: ${message}`);
    this.name = "SecurityError";
    this.code = code;
    this.details = details;
  }
}

export interface SecurityIssue {
  readonly code: SecurityIssueCode;
  readonly message: string;
}

export function issue(code: SecurityIssueCode, message: string): SecurityIssue {
  return { code, message };
}
