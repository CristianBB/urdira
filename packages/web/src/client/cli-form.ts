import type { QueryChoice } from "./query-choices.js";

export interface CliFormCommand {
  readonly arguments?: readonly Readonly<Record<string, unknown>>[];
  readonly options?: readonly string[];
  readonly input_schema?: Readonly<Record<string, unknown>>;
}

const choiceLabels: Readonly<Record<string, string>> = {
  all: "All supported clients",
  "claude-code": "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  cursor: "Cursor",
  vscode: "VS Code / GitHub Copilot",
  cline: "Cline",
  roo: "Roo Code",
  "claude-desktop": "Claude Desktop",
  user: "User configuration",
};

function object(value: unknown): Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Readonly<Record<string, unknown>> : {};
}

function advertisedValues(command: CliFormCommand, name: string): readonly string[] {
  const inputProperties = object(object(command.input_schema)["properties"]);
  const optionsSchema = object(inputProperties["options"]);
  const optionProperties = object(optionsSchema["properties"]);
  const fieldSchema = object(optionProperties[name]);
  return Array.isArray(fieldSchema["enum"]) ? fieldSchema["enum"].filter((value): value is string => typeof value === "string") : [];
}

export function cliFieldChoices(name: string, command: CliFormCommand, workspaces: readonly Readonly<Record<string, unknown>>[], codebases: readonly Readonly<Record<string, unknown>>[]): readonly QueryChoice[] {
  if (name === "workspace" || name === "workspace-id") return workspaces.map((workspace) => ({ value: String(workspace["workspace_id"]), label: `${String(workspace["workspace_label"] ?? workspace["directory_name"] ?? workspace["project_name"] ?? "Workspace")} · ${String(workspace["workspace_id"])}` }));
  if (name === "codebase" || name === "codebase-id") return codebases.map((codebase) => ({ value: String(codebase["codebase_id"]), label: `${String(codebase["display_name"] ?? "Project")} · ${String(codebase["codebase_id"])}` }));
  return advertisedValues(command, name).map((value) => ({ value, label: choiceLabels[value] ?? value.replaceAll("-", " ") }));
}

/** Web-only transport controls and duplicate CLI spellings do not belong in the form. */
export function visibleCliOptions(command: CliFormCommand): readonly string[] {
  const argumentNames = new Set((command.arguments ?? []).map((entry) => String(entry["name"] ?? "")));
  return (command.options ?? []).filter((name) => !["json", "dry-run", "confirm", "proposal-id"].includes(name) && !argumentNames.has(name));
}
