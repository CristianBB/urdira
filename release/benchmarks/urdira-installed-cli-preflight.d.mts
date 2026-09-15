export function validateInstalledUrdiraCli(options: { readonly cliPath: string; readonly releaseRoot: string; readonly expectedSha256?: string; readonly expectedVersion?: string }): Promise<{
  readonly status: "passed";
  readonly command: readonly ["status", "--json"];
  readonly command_name: "status";
  readonly cli_path: string;
  readonly cli_sha256: string;
  readonly cli_version: string | null;
  readonly model_invoked: false;
  readonly daemon_started: false;
}>;
