import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Core } from "cytoscape";
import { Client, StreamableHTTPClientTransport, type Tool } from "@modelcontextprotocol/client";
import { buildContinuationRequest, buildOperationRequest, buildSearchRequest, type SearchMode } from "./query.js";
import { nextQueryCursor, queryChoices, type QueryChoice } from "./query-choices.js";
import { graphDataFromPage, type GraphData } from "./graph-data.js";
import { pageFromResult, QueryProgress, RawInspector, record, ResultPage, StructuredView, type JsonRecord } from "./renderers.js";
import { resolveThemePreference, THEME_STORAGE_KEY, toggledTheme, type InterfaceTheme } from "./theme.js";
import { operationAvailability, shouldUseRetainedSnapshot, workspaceHealthIssue, workspaceStatusLabel } from "./workspace-health.js";
import { SearchableSelect } from "./searchable-select.js";
import { symbolSelectorForChoice } from "./result-presentation.js";
import { McpRequestBuilder } from "./mcp-request-builder.js";
import { initialSchemaValue, parseMcpRequest, validateMcpRequest } from "./mcp-request-schema.js";
import { cliFieldChoices, visibleCliOptions, type CliFormCommand } from "./cli-form.js";
import { pipelineMcpExamples, pipelinePresentation } from "./mcp-pipeline-examples.js";
import "./styles.css";

type View = "Workspaces" | "Search" | "Explorer" | "Graph" | "CLI" | "MCP";
type IconName = "workspace" | "search" | "explorer" | "graph" | "terminal" | "braces" | "sun" | "moon" | "refresh" | "plus" | "settings" | "folder" | "branch" | "activity" | "database" | "spark";

function Icon({ name, size = 18 }: { name: IconName; size?: number }): React.JSX.Element {
  const paths: Record<IconName, React.JSX.Element> = {
    workspace: <><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M8 4v5"/></>,
    search: <><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></>,
    explorer: <><path d="M4 5a2 2 0 0 1 2-2h4l2 3h6a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2Z"/><path d="m9 15 2-2-2-2m4 4h3"/></>,
    graph: <><circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="7" r="2.5"/><circle cx="12" cy="18" r="2.5"/><path d="m8.4 6.2 7.1.6M7.4 8l3.3 7.7m5.8-6.5-3.1 6.6"/></>,
    terminal: <><rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3m5 0h5"/></>,
    braces: <><path d="M8 3H6a2 2 0 0 0-2 2v4a2 2 0 0 1-2 2 2 2 0 0 1 2 2v4a2 2 0 0 0 2 2h2m8-16h2a2 2 0 0 1 2 2v4a2 2 0 0 0 2 2 2 2 0 0 0-2 2v4a2 2 0 0 1-2 2h-2"/></>,
    sun: <><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></>,
    moon: <path d="M20 15.2A8.5 8.5 0 0 1 8.8 4 8.5 8.5 0 1 0 20 15.2Z"/>,
    refresh: <><path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/></>,
    plus: <path d="M12 5v14M5 12h14"/>,
    settings: <><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1A1.7 1.7 0 0 0 9 4.6 1.7 1.7 0 0 0 10 3v-.2h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z"/></>,
    folder: <path d="M3 6a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>,
    branch: <><circle cx="6" cy="5" r="2"/><circle cx="18" cy="6" r="2"/><circle cx="6" cy="19" r="2"/><path d="M6 7v10m2-8h5a5 5 0 0 0 5-5"/></>,
    activity: <path d="M3 12h4l2-7 4 14 2-7h6"/>,
    database: <><ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v7c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12v7c0 1.7 3.6 3 8 3s8-1.3 8-3v-7"/></>,
    spark: <><path d="m12 3 1.3 4.2L17 9l-3.7 1.8L12 15l-1.3-4.2L7 9l3.7-1.8Z"/><path d="m19 15 .7 2.3L22 18l-2.3.7L19 21l-.7-2.3L16 18l2.3-.7Z"/></>,
  };
  return <svg className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

const primaryNavigation: ReadonlyArray<{ view: View; icon: IconName }> = [
  { view: "Workspaces", icon: "workspace" }, { view: "Search", icon: "search" }, { view: "Explorer", icon: "explorer" }, { view: "Graph", icon: "graph" },
];
const advancedNavigation: ReadonlyArray<{ view: View; icon: IconName }> = [{ view: "CLI", icon: "terminal" }, { view: "MCP", icon: "braces" }];
const viewDescriptions: Record<View, string> = {
  Workspaces: "Manage the projects and working trees available to local code intelligence.",
  Search: "Find exact source text or discover implementation details by intent.",
  Explorer: "Move through artifacts, symbols, source, references, and architecture.",
  Graph: "Follow structured relationships with coverage and certainty kept visible.",
  CLI: "Run registered Urdira commands through their ordinary safety gates.",
  MCP: "Inspect and call the same structured tools exposed to coding agents.",
};
const initialInterfaceTheme = resolveThemePreference(localStorage.getItem(THEME_STORAGE_KEY), matchMedia("(prefers-color-scheme: dark)").matches);
document.documentElement.dataset["theme"] = initialInterfaceTheme;
document.documentElement.style.colorScheme = initialInterfaceTheme;

async function api(path: string, init: RequestInit = {}): Promise<JsonRecord> {
  const response = await fetch(path, { ...init, headers: { ...(init.body === undefined ? {} : { "content-type": "application/json" }), ...init.headers } });
  const value = await response.json() as JsonRecord;
  if (!response.ok) throw new Error(String(record(value["error"])["message"] ?? response.statusText));
  return value;
}

async function executeCli(command: string, args: string[] = [], options: JsonRecord = {}, confirmed?: { proposal_id: string; proposal_digest: string }): Promise<unknown> {
  const started = await api("/api/v1/cli/execute", { method: "POST", body: JSON.stringify({ api_version: 1, command, args, options, ...(confirmed === undefined ? {} : { proposal_id: confirmed.proposal_id, proposal_digest: confirmed.proposal_digest }) }) });
  const response = await fetch(`/api/v1/cli/operations/${encodeURIComponent(String(started["operation_id"]))}/events`);
  const terminal = (await response.text()).trim().split("\n\n").map((entry) => entry.replace(/^data: /, "")).filter(Boolean).map((entry) => JSON.parse(entry) as JsonRecord).at(-1);
  if (terminal?.["type"] === "failed") throw new Error(String(terminal["error"]));
  return record(terminal?.["result"])["data"];
}

async function previewCli(command: string, args: string[] = [], options: JsonRecord = {}): Promise<{ proposal_id: string; proposal_digest: string; result: unknown }> {
  const result = await api("/api/v1/cli/preview", { method: "POST", body: JSON.stringify({ api_version: 1, command, args, options }) });
  return { proposal_id: String(result["proposal_id"]), proposal_digest: String(result["proposal_digest"]), result: result["result"] };
}

async function callTool(client: Client, tools: Tool[], name: string, args: JsonRecord): Promise<unknown> {
  const errors = validateMcpRequest(args, tools.find((entry) => entry.name === name)?.inputSchema ?? {});
  if (errors.length > 0) throw new Error(errors.join(" "));
  return client.callTool({ name, arguments: args });
}

function branchLabel(workspace: JsonRecord): string {
  const vcs = record(workspace["vcs_state"]); const dirty = vcs["dirty"] === "dirty" || vcs["dirty"] === true ? " • uncommitted changes" : "";
  return `${String(workspace["workspace_label"] ?? vcs["branch"] ?? workspace["directory_name"] ?? workspace["display_root"])} · ${String(workspace["directory_name"] ?? workspace["display_root"])}${dirty}`;
}

const wait = async (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));

function WorkspaceHealthBanner({ workspace, busy, onReindex }: { workspace?: JsonRecord | undefined; busy: boolean; onReindex: (workspaceId: string) => Promise<void> }): React.JSX.Element | null {
  const issue = workspaceHealthIssue(workspace);
  if (issue === undefined) return null;
  const workspaceId = String(workspace?.["workspace_id"] ?? "");
  return <aside className={`health-banner ${issue.tone}`} role={issue.tone === "danger" ? "alert" : "status"}>
    <span className="health-icon"><Icon name="activity"/></span>
    <div className="health-copy"><b>{issue.title}</b><p>{issue.message}</p><div className="health-meta">{issue.technical_code && <code>{issue.technical_code}</code>}{issue.occurred_at && <span>{new Date(issue.occurred_at).toLocaleString()}</span>}</div></div>
    {issue.action === "reindex" && <button className="button secondary" disabled={busy || !workspaceId} onClick={() => void onReindex(workspaceId)}><Icon name="refresh" size={15}/>{busy ? "Repairing…" : "Retry indexing"}</button>}
  </aside>;
}

const primaryArtifactFilter = {
  paths: ["src/**", "lib/**", "app/**", "apps/**", "packages/**", "tests/**", "docs/**", "scripts/**", "*.md", "*.json", "*.mjs", "*.ts"],
  include_external: false,
  include_generated: false,
};

function useArtifactChoices(client: Client | undefined, tools: Tool[], workspace: JsonRecord | undefined): { choices: readonly QueryChoice[]; loading: boolean; error: string } {
  const [choices, setChoices] = useState<readonly QueryChoice[]>([]); const [loading, setLoading] = useState(false); const [error, setError] = useState("");
  const workspaceId = String(workspace?.["workspace_id"] ?? "");
  const operationReady = operationAvailability(workspace, "core:find_artifacts").available; const freshness = typeof workspace?.["current_snapshot_id"] === "string" ? "current" : "wait";
  useEffect(() => {
    let active = true; setChoices([]); setError("");
    if (!client || !workspaceId || !operationReady) return () => { active = false; };
    setLoading(true);
    const filter = primaryArtifactFilter;
    void (async () => {
      let result = await callTool(client, tools, "urdira_query", buildOperationRequest(workspaceId, "core:find_artifacts", { filter }, 30_000, freshness, 250));
      const collected = new Map<string, QueryChoice>();
      for (let page = 0; page < 12; page += 1) {
        for (const choice of queryChoices(result, "artifact")) collected.set(choice.value, choice);
        const cursor = nextQueryCursor(result);
        if (cursor === undefined || collected.size >= 1_000) break;
        result = await callTool(client, tools, "urdira_query", buildContinuationRequest(workspaceId, cursor));
      }
      if (active) setChoices([...collected.values()].sort((left, right) => left.label.localeCompare(right.label)));
    })()
      .catch((reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : String(reason)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [client, tools, workspaceId, operationReady, freshness]);
  return { choices, loading, error };
}

function useSymbolChoices(client: Client | undefined, tools: Tool[], workspace: JsonRecord | undefined, path: string): { choices: readonly QueryChoice[]; loading: boolean; error: string } {
  const [choices, setChoices] = useState<readonly QueryChoice[]>([]); const [loading, setLoading] = useState(false); const [error, setError] = useState("");
  const workspaceId = String(workspace?.["workspace_id"] ?? "");
  const operationReady = operationAvailability(workspace, "core:get_outline").available; const freshness = typeof workspace?.["current_snapshot_id"] === "string" ? "current" : "wait";
  useEffect(() => {
    let active = true; setChoices([]); setError("");
    if (!client || !workspaceId || !path || !operationReady) return () => { active = false; };
    setLoading(true);
    const args = { container: { subject_type: "artifact", path }, depth: 3, include_non_public: true };
    void (async () => {
      let result = await callTool(client, tools, "urdira_query", buildOperationRequest(workspaceId, "core:get_outline", args, 30_000, freshness));
      const collected = new Map<string, QueryChoice>();
      for (let page = 0; page < 20; page += 1) {
        for (const choice of queryChoices(result, "symbol")) collected.set(choice.value, choice);
        const cursor = nextQueryCursor(result);
        if (cursor === undefined || collected.size >= 1_000) break;
        result = await callTool(client, tools, "urdira_query", buildContinuationRequest(workspaceId, cursor));
      }
      if (active) setChoices([...collected.values()].sort((left, right) => left.label.localeCompare(right.label)));
    })()
      .catch((reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : String(reason)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [client, tools, workspaceId, operationReady, freshness, path]);
  return { choices, loading, error };
}

function App(): React.JSX.Element {
  const [view, setView] = useState<View>("Workspaces"); const [client, setClient] = useState<Client>(); const [tools, setTools] = useState<Tool[]>([]);
  const [workspaces, setWorkspaces] = useState<JsonRecord[]>([]); const [codebases, setCodebases] = useState<JsonRecord[]>([]); const [workspaceId, setWorkspaceId] = useState(""); const [codebaseId, setCodebaseId] = useState("");
  const [error, setError] = useState(""); const [loading, setLoading] = useState(true); const [repairingId, setRepairingId] = useState("");
  const [theme, setTheme] = useState<InterfaceTheme>(initialInterfaceTheme);
  const refresh = async (): Promise<JsonRecord[]> => {
    const [workspaceData, codebaseData, indexData] = await Promise.all([executeCli("workspace-list"), executeCli("codebase-list"), executeCli("index")]);
    const next = Array.isArray(record(workspaceData)["workspaces"]) ? record(workspaceData)["workspaces"] as JsonRecord[] : [];
    const projects = Array.isArray(record(codebaseData)["codebases"]) ? record(codebaseData)["codebases"] as JsonRecord[] : [];
    const indexRows = Array.isArray(record(indexData)["workspaces"]) ? record(indexData)["workspaces"] as JsonRecord[] : [];
    const indexByWorkspace = new Map(indexRows.map((entry) => [String(entry["workspace_id"]), entry]));
    const enriched: JsonRecord[] = next.map((workspace) => ({ ...workspace, index_status: indexByWorkspace.get(String(workspace["workspace_id"])) ?? {} }));
    setWorkspaces(enriched); setCodebases(projects); setError("");
    const selected = enriched.find((workspace) => workspace["workspace_id"] === workspaceId && workspace["status"] !== "removed") ?? enriched.find((workspace) => workspace["status"] !== "removed");
    if (selected) { setWorkspaceId(String(selected["workspace_id"])); setCodebaseId(String(selected["codebase_id"])); }
    return enriched;
  };
  const reindexWorkspace = async (id: string): Promise<void> => {
    setRepairingId(id); setError("");
    try {
      const proposal = await previewCli("reindex", [id]);
      await executeCli("reindex", [id], {}, proposal);
      for (let attempt = 0; attempt < 30; attempt += 1) {
        const updated = await refresh();
        const workspace = updated.find((entry) => entry["workspace_id"] === id);
        if (workspace === undefined || workspace["status"] === "ready") break;
        if (attempt < 29) await wait(1_000);
      }
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setRepairingId(""); }
  };
  const refreshRef = useRef(refresh); refreshRef.current = refresh;
  useEffect(() => {
    const mcp = new Client({ name: "urdira-web", version: "0.3.3" }, { versionNegotiation: { mode: "auto" } });
    const transport = new StreamableHTTPClientTransport(new URL("/mcp", location.origin));
    void mcp.connect(transport).then(async () => { setClient(mcp); setTools((await mcp.listTools()).tools); await refresh(); }).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason))).finally(() => setLoading(false));
    return () => { void mcp.close(); };
  }, []);
  useEffect(() => {
    if (loading) return undefined;
    const timer = window.setInterval(() => { void refreshRef.current().catch(() => undefined); }, 15_000);
    return () => window.clearInterval(timer);
  }, [loading]);
  useEffect(() => {
    document.documentElement.dataset["theme"] = theme;
    document.documentElement.style.colorScheme = theme;
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  }, [theme]);
  const activeWorkspace = workspaces.find((workspace) => workspace["workspace_id"] === workspaceId); const activeProject = codebases.find((project) => project["codebase_id"] === codebaseId);
  const projectOptions = codebases.map((project) => ({ id: String(project["codebase_id"]), label: String(project["display_name"]) }));
  const scopedWorkspaces = workspaces.filter((workspace) => workspace["status"] !== "removed" && workspace["codebase_id"] === codebaseId);
  const workspaceOptions = scopedWorkspaces.map((workspace) => ({ id: String(workspace["workspace_id"]), label: branchLabel(workspace) }));
  const setProjectByLabel = (label: string): void => { const option = projectOptions.find((entry) => entry.label === label); if (!option) return; setCodebaseId(option.id); const first = workspaces.find((workspace) => workspace["status"] !== "removed" && workspace["codebase_id"] === option.id); setWorkspaceId(String(first?.["workspace_id"] ?? "")); };
  const workspaceStatus = String(activeWorkspace?.["status"] ?? "not selected");
  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><span className="brand-mark"><svg viewBox="0 0 32 32" aria-hidden="true"><circle cx="9" cy="10" r="3"/><circle cx="23" cy="8" r="3"/><circle cx="21" cy="23" r="3"/><path d="m12 10 8-1m1 2-1 9m-2 1L11 12"/></svg></span><div><strong>Urdira</strong><small>Code intelligence</small></div></div>
      <nav aria-label="Main navigation">
        {primaryNavigation.map((item) => <button key={item.view} className={view === item.view ? "active" : ""} aria-current={view === item.view ? "page" : undefined} onClick={() => setView(item.view)}><span><Icon name={item.icon}/></span>{item.view}</button>)}
        <div className="nav-label">Developer tools</div>
        {advancedNavigation.map((item) => <button key={item.view} className={view === item.view ? "active" : ""} aria-current={view === item.view ? "page" : undefined} onClick={() => setView(item.view)}><span><Icon name={item.icon}/></span>{item.view}</button>)}
      </nav>
      <div className="sidebar-footer">
        <button className="theme-toggle" onClick={() => setTheme((current) => toggledTheme(current))} aria-label={`Switch to ${theme === "light" ? "dark" : "light"} mode`} title={`Switch to ${theme === "light" ? "dark" : "light"} mode`}><span><Icon name={theme === "light" ? "moon" : "sun"}/></span><span>{theme === "light" ? "Dark mode" : "Light mode"}</span><small>Theme</small></button>
        <div className="connection"><i className={client ? "connected" : ""}/><div><b>{client ? "Runtime connected" : "Connecting"}</b><small>Private · loopback only</small></div></div>
      </div>
    </aside>
    <div className="workspace-shell">
      <div className="context-bar">
        <div className="context-title"><span className="project-monogram">{String(activeProject?.["display_name"] ?? "U").slice(0, 1).toUpperCase()}</span><div><small>Current project</small><b>{activeProject?.["display_name"] ? String(activeProject["display_name"]) : "Choose a project"}</b></div></div>
        <label className="context-field"><span>Project</span><div className="input-with-icon"><Icon name="database" size={15}/><select value={codebaseId} onChange={(event) => { const option = projectOptions.find((entry) => entry.id === event.target.value); if (option) setProjectByLabel(option.label); }}><option value="" disabled>Choose a project</option>{projectOptions.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}</select></div></label>
        <label className="context-field"><span>Workspace</span><div className="input-with-icon"><Icon name="branch" size={15}/><select value={workspaceId} onChange={(event) => setWorkspaceId(event.target.value)}><option value="" disabled>Choose a workspace</option>{workspaceOptions.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}</select></div></label>
        <button className="button tertiary context-action" onClick={() => setView("Workspaces")}><Icon name="settings" size={16}/><span>Manage</span></button>
      </div>
      <main>
        <header className="page-header"><div><div className="eyebrow"><span>{activeProject?.["display_name"] ? String(activeProject["display_name"]) : "Local index"}</span><i/> <span>{activeWorkspace ? String(record(activeWorkspace["vcs_state"])["branch"] ?? activeWorkspace["workspace_label"] ?? "Workspace") : "No workspace"}</span></div><h1>{view === "MCP" ? "MCP tools" : view}</h1><p>{viewDescriptions[view]}</p></div><div className="header-status"><span className={`status-dot ${workspaceStatus}`}/><div><small>Workspace status</small><b>{workspaceStatusLabel(activeWorkspace)}</b></div></div></header>
        {error && <div className="banner error-banner" role="alert"><span>{error}</span><button onClick={() => setError("")}>Dismiss</button></div>}
        {!loading && view !== "Workspaces" && <WorkspaceHealthBanner workspace={activeWorkspace} busy={repairingId === workspaceId} onReindex={reindexWorkspace}/>}
        {loading ? <div className="state-card"><span className="spinner"/>Connecting to the local Urdira runtime…</div> : <>{view === "Workspaces" && <Workspaces workspaces={workspaces} codebases={codebases} refresh={refresh} setError={setError} repairingId={repairingId} onReindex={reindexWorkspace}/>} {view === "Search" && <Search client={client} tools={tools} workspace={activeWorkspace}/>} {view === "Explorer" && <Explorer client={client} tools={tools} workspace={activeWorkspace}/>} {view === "Graph" && <Graph client={client} tools={tools} workspace={activeWorkspace}/>} {view === "CLI" && <CliConsole workspaces={workspaces} codebases={codebases}/>} {view === "MCP" && <McpConsole client={client} tools={tools} workspaceId={workspaceId}/>}</>}
      </main>
    </div>
  </div>;
}

function Workspaces({ workspaces, codebases, refresh, setError, repairingId, onReindex }: { workspaces: JsonRecord[]; codebases: JsonRecord[]; refresh: () => Promise<unknown>; setError: (value: string) => void; repairingId: string; onReindex: (workspaceId: string) => Promise<void> }): React.JSX.Element {
  const [picker, setPicker] = useState<JsonRecord>(); const [directory, setDirectory] = useState(""); const [renameId, setRenameId] = useState(""); const [rename, setRename] = useState(""); const [busy, setBusy] = useState(false);
  const [pendingAction, setPendingAction] = useState<{ command: string; args: string[]; options: JsonRecord; title: string; message: string; action: string }>();
  const choose = async (path?: string): Promise<void> => { try { const value = await api(`/api/v1/directories${path ? `?path=${encodeURIComponent(path)}` : ""}`); setPicker(value); setDirectory(String(value["directory"])); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } };
  const confirm = async (command: string, args: string[], options: JsonRecord = {}): Promise<void> => { setBusy(true); try { const proposal = await previewCli(command, args, options); await executeCli(command, args, options, proposal); await refresh(); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } finally { setBusy(false); } };
  const activeWorkspaces = workspaces.filter((workspace) => workspace["status"] !== "removed");
  const readyWorkspaces = activeWorkspaces.filter((workspace) => workspace["status"] === "ready").length;
  return <section className="content-stack"><div className="overview-grid"><div className="overview-card"><span><Icon name="database"/></span><div><strong>{codebases.length}</strong><small>Projects</small></div></div><div className="overview-card"><span><Icon name="branch"/></span><div><strong>{activeWorkspaces.length}</strong><small>Active workspaces</small></div></div><div className="overview-card"><span><Icon name="activity"/></span><div><strong>{readyWorkspaces}/{activeWorkspaces.length}</strong><small>Ready to query</small></div></div></div><div className="section-heading"><div><p className="section-kicker">Workspace inventory</p><h2>Indexed workspaces</h2><p>Each branch, worktree, or directory keeps an independent query scope.</p></div><div className="button-row"><button className="button secondary" onClick={() => void refresh().catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)))}><Icon name="refresh" size={15}/>Refresh</button><button className="button primary" onClick={() => void choose()}><Icon name="plus" size={15}/>Add workspace</button></div></div>{picker && <div className="panel directory-picker"><div className="picker-head"><div><small>Selected directory</small><b>{directory}</b></div><div className="button-row"><button className="button secondary" onClick={() => void choose(String(picker["parent"]))}>Up one level</button><button className="button primary" disabled={busy} onClick={() => void confirm("workspace-add", [directory])}>Register directory</button><button className="icon-button" onClick={() => setPicker(undefined)} aria-label="Close directory picker">×</button></div></div><div className="folder-grid">{(Array.isArray(picker["directories"]) ? picker["directories"] as JsonRecord[] : []).map((entry) => <button key={String(entry["path"])} onClick={() => void choose(String(entry["path"]))}><span><Icon name="folder" size={16}/></span>{String(entry["name"])}</button>)}</div></div>}
    {workspaces.length === 0 ? <div className="state-card empty-state"><b>No workspaces registered</b><span>Add a local project directory to begin indexing.</span></div> : <div className="workspace-grid">{workspaces.map((workspace) => {
      const vcs = record(workspace["vcs_state"]); const removed = workspace["status"] === "removed"; const id = String(workspace["workspace_id"]); const label = String(workspace["workspace_label"] ?? workspace["directory_name"] ?? "Workspace"); const issue = workspaceHealthIssue(workspace); const indexStatus = record(workspace["index_status"]);
      const activelyIndexing = workspace["status"] === "indexing" || workspace["status"] === "registering";
      return <article className={`workspace-card ${removed ? "removed" : ""} ${issue?.tone ?? ""}`} key={id}><div className="card-head"><div><span className="project-name">{String(workspace["project_name"] ?? "Project")}</span><h3>{label}</h3></div><span className={`status-badge ${String(workspace["status"])}`}>{workspaceStatusLabel(workspace)}</span></div><div className="workspace-path">{String(workspace["display_root"])}</div>{issue && !removed && <div className={`scan-issue ${issue.tone}`}><div><b>{issue.title}</b><p>{issue.message}</p></div><div className="health-meta">{issue.technical_code && <code>{issue.technical_code}</code>}{issue.occurred_at && <span>{new Date(issue.occurred_at).toLocaleString()}</span>}</div></div>}<div className="frontier-row"><span className={indexStatus["source_ready"] === true ? "ready" : ""}>Source</span><span className={indexStatus["structural_ready"] === true ? "ready" : ""}>Structure</span><span className={indexStatus["semantic_ready"] === true ? "ready" : ""}>Semantic</span></div><div className="metric-row"><div><small>Commit</small><b>{String(vcs["short_commit"] ?? "No Git")}</b></div><div><small>Working tree</small><b className={vcs["dirty"] === "dirty" ? "danger-text" : ""}>{vcs["dirty"] === "dirty" ? "Uncommitted changes" : vcs["dirty"] === "clean" ? "Clean" : "Not a Git workspace"}</b></div><div><small>Observed</small><b>{typeof vcs["observation_age_ms"] === "number" ? `${Math.round(Number(vcs["observation_age_ms"]) / 1000)}s ago` : "—"}</b></div></div><details className="workspace-technical"><summary>Technical workspace details</summary><code>{id}</code></details><div className="card-actions">{!removed ? <><button className="button secondary" disabled={repairingId === id || activelyIndexing} onClick={() => void onReindex(id)}><Icon name="refresh" size={15}/>{repairingId === id ? "Repairing…" : activelyIndexing ? workspace["indexing_activity"] === "checking_for_updates" ? "Checking…" : "Indexing…" : issue?.action === "reindex" ? "Retry indexing" : "Reindex"}</button><button className="button danger" onClick={() => setPendingAction({ command: "workspace-remove", args: [id], options: {}, title: `Remove ${label}?`, message: "The workspace will stop appearing in active queries but can still be recovered for 24 hours.", action: "Remove workspace" })}>Remove</button></> : <button className="button danger" onClick={() => setPendingAction({ command: "workspace-purge", args: [id], options: { payload: { force: true } }, title: `Purge ${label} permanently?`, message: "This permanently deletes the removed workspace after Urdira verifies that no active reference still requires it.", action: "Purge permanently" })}>Purge permanently</button>}</div></article>;
    })}</div>}
    <div className="panel"><div className="section-heading compact"><div><h2>Projects</h2><p>Worktrees from the same Git repository are grouped automatically.</p></div></div><div className="project-list">{codebases.map((project) => <div className="project-row" key={String(project["codebase_id"])}><div><b>{String(project["display_name"])}</b><small>{String(project["workspace_count"] ?? workspaces.filter((entry) => entry["codebase_id"] === project["codebase_id"]).length)} workspaces</small></div>{renameId === project["codebase_id"] ? <div className="button-row"><input value={rename} onChange={(event) => setRename(event.target.value)} autoFocus/><button className="button primary" disabled={!rename.trim()} onClick={() => void confirm("codebase-rename", [String(project["codebase_id"]), rename]).then(() => setRenameId(""))}>Save name</button></div> : <button className="button secondary" onClick={() => { setRenameId(String(project["codebase_id"])); setRename(String(project["display_name"])); }}>Rename</button>}</div>)}</div></div>
    {pendingAction && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) setPendingAction(undefined); }}><div className="confirmation-dialog" role="dialog" aria-modal="true" aria-labelledby="confirmation-title"><span className="dialog-icon"><Icon name="activity"/></span><h2 id="confirmation-title">{pendingAction.title}</h2><p>{pendingAction.message}</p><details className="dialog-scope"><summary>Technical workspace identifier</summary><code>{pendingAction.args[0]}</code></details><div className="button-row"><button className="button secondary" disabled={busy} onClick={() => setPendingAction(undefined)}>Cancel</button><button className="button danger" disabled={busy} onClick={() => void confirm(pendingAction.command, pendingAction.args, pendingAction.options).then(() => setPendingAction(undefined))}>{busy ? "Working…" : pendingAction.action}</button></div></div></div>}
  </section>;
}

function Search({ client, tools, workspace }: { client?: Client | undefined; tools: Tool[]; workspace?: JsonRecord | undefined }): React.JSX.Element {
  const [mode, setMode] = useState<SearchMode>("lexical"); const [text, setText] = useState(""); const [result, setResult] = useState<unknown>(); const [pageNumber, setPageNumber] = useState(1); const [history, setHistory] = useState<readonly { result: unknown; pageNumber: number }[]>([]); const [loading, setLoading] = useState(false); const [fieldError, setFieldError] = useState("");
  const workspaceId = String(workspace?.["workspace_id"] ?? "");
  const operation = mode === "lexical" ? "core:search_text" : mode === "semantic" ? "core:search_semantic" : "core:search_hybrid";
  const availability = operationAvailability(workspace, operation);
  const freshness = shouldUseRetainedSnapshot(workspace) ? "current" : "wait";
  const run = async (args: JsonRecord = buildSearchRequest(workspaceId, mode, text, freshness), targetPage = 1, rememberCurrent = false): Promise<void> => { if (!client || !availability.available) return; setFieldError(""); setLoading(true); try { const nextResult = await callTool(client, tools, "urdira_query", args); if (rememberCurrent && result !== undefined) setHistory((entries) => [...entries, { result, pageNumber }]); else if (targetPage === 1) setHistory([]); setResult(nextResult); setPageNumber(targetPage); } catch (reason) { setFieldError(reason instanceof Error ? reason.message : String(reason)); } finally { setLoading(false); } };
  const previousPage = (): void => { const previous = history.at(-1); if (previous === undefined) return; setHistory((entries) => entries.slice(0, -1)); setResult(previous.result); setPageNumber(previous.pageNumber); };
  return <section className="content-stack"><div className="search-panel"><div className="mode-tabs">{(["lexical", "semantic", "hybrid"] as const).map((entry) => { const entryOperation = entry === "lexical" ? "core:search_text" : entry === "semantic" ? "core:search_semantic" : "core:search_hybrid"; const state = operationAvailability(workspace, entryOperation); return <button key={entry} className={mode === entry ? "active" : ""} aria-disabled={!state.available} title={state.message} onClick={() => { setMode(entry); setResult(undefined); setPageNumber(1); setHistory([]); setFieldError(""); }}><b>{entry}</b><span>{entry === "lexical" ? "Exact source text" : entry === "semantic" ? "Meaning and behavior" : "Best of both"}</span>{!state.available && <em>Unavailable</em>}</button>; })}</div><form onSubmit={(event) => { event.preventDefault(); void run(); }}><label><span>{mode === "lexical" ? "Text to find" : "Describe what the code does"}</span><div className="search-box"><input value={text} onChange={(event) => setText(event.target.value)} placeholder={mode === "lexical" ? "e.g. core:daemon_restart_required" : "e.g. where daemon compatibility is negotiated"}/><button className="button primary" disabled={!client || !workspaceId || !text.trim() || loading || !availability.available}>Search</button></div></label>{!availability.available && <div className="operation-warning"><b>{mode} search is not ready</b><span>{availability.message}</span>{availability.reason_code && <code>{availability.reason_code}</code>}</div>}{fieldError && <p className="field-error">{fieldError}</p>}<p className="form-help">{freshness === "current" ? "Using the last successful snapshot while the failed scan is repaired." : `This query waits for the ${mode === "lexical" ? "source" : "semantic"} frontier.`}</p></form></div><ResultPage result={result} operation={operation} loading={loading} pageNumber={pageNumber} canPrevious={history.length > 0} loadingLabel={`Searching ${mode} index`} onNext={(cursor) => void run(buildContinuationRequest(workspaceId, cursor), pageNumber + 1, true)} onPrevious={previousPage}/></section>;
}

const explorerOperations = [{ id: "core:find_artifacts", label: "Files and artifacts", help: "List indexed source artifacts", field: "" }, { id: "core:discover_definitions", label: "Definitions", help: "Find registered definitions", field: "Definition text" }, { id: "core:get_outline", label: "File outline", help: "Browse members in a file", field: "Relative file path" }, { id: "core:get_source", label: "Source", help: "Read indexed source for a file", field: "Relative file path" }, { id: "core:find_references", label: "References", help: "Find references to a symbol", field: "Symbol name" }, { id: "core:inspect_architecture", label: "Architecture", help: "Inspect entry points and boundaries", field: "" }] as const;
function explorerArgs(operation: string, value: string, symbolChoice?: QueryChoice): JsonRecord { const text = value.trim(); if (operation === "core:find_artifacts") return { filter: primaryArtifactFilter }; if (operation === "core:discover_definitions") return { matcher: { text, mode: "contains", limit: 50 } }; if (operation === "core:get_outline") return { container: { subject_type: "artifact", path: text }, depth: 3, include_non_public: true }; if (operation === "core:get_source") return { subjects: [{ subject_type: "artifact", path: text }], source: { mode: "body", max_characters_per_snippet: 40_000, max_total_characters: 40_000, context_lines: 2 } }; if (operation === "core:find_references") return { target: symbolSelectorForChoice(symbolChoice, text), include_declarations: true, filter: primaryArtifactFilter }; return { views: ["entry_points", "boundaries", "public_surfaces", "extension_points", "layers"], max_relation_depth: 3, filter: primaryArtifactFilter }; }
function Explorer({ client, tools, workspace }: { client?: Client | undefined; tools: Tool[]; workspace?: JsonRecord | undefined }): React.JSX.Element {
  const [operation, setOperation] = useState<string>(explorerOperations[0].id); const [value, setValue] = useState(""); const [artifactPath, setArtifactPath] = useState(""); const [result, setResult] = useState<unknown>(); const [pageNumber, setPageNumber] = useState(1); const [history, setHistory] = useState<readonly { result: unknown; pageNumber: number }[]>([]); const [loading, setLoading] = useState(false); const [error, setError] = useState(""); const selected = explorerOperations.find((entry) => entry.id === operation)!;
  const workspaceId = String(workspace?.["workspace_id"] ?? ""); const freshness = shouldUseRetainedSnapshot(workspace) ? "current" : "wait"; const availability = operationAvailability(workspace, operation);
  const artifacts = useArtifactChoices(client, tools, workspace); const symbols = useSymbolChoices(client, tools, workspace, operation === "core:find_references" ? artifactPath : "");
  const fileOperation = operation === "core:get_outline" || operation === "core:get_source"; const requiresValue = selected.field !== ""; const effectiveValue = fileOperation ? artifactPath : value;
  const selectedSymbol = symbols.choices.find((choice) => choice.value === value);
  const run = async (continuation?: JsonRecord, targetPage = 1, rememberCurrent = false): Promise<void> => { if (!client || !availability.available) return; setError(""); setLoading(true); try { const request = continuation ?? buildOperationRequest(workspaceId, operation, explorerArgs(operation, effectiveValue, selectedSymbol), 30_000, freshness); const nextResult = await callTool(client, tools, "urdira_query", request); if (rememberCurrent && result !== undefined) setHistory((entries) => [...entries, { result, pageNumber }]); else if (targetPage === 1) setHistory([]); setResult(nextResult); setPageNumber(targetPage); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } finally { setLoading(false); } };
  const previousPage = (): void => { const previous = history.at(-1); if (previous === undefined) return; setHistory((entries) => entries.slice(0, -1)); setResult(previous.result); setPageNumber(previous.pageNumber); };
  return <section className="explorer-layout"><aside className="operation-list">{explorerOperations.map((entry) => { const state = operationAvailability(workspace, entry.id); return <button key={entry.id} className={operation === entry.id ? "active" : ""} aria-disabled={!state.available} title={state.message} onClick={() => { setOperation(entry.id); setValue(""); setArtifactPath(""); setResult(undefined); setPageNumber(1); setHistory([]); setError(""); }}><b>{entry.label}</b><span>{entry.help}</span>{!state.available && <em>Unavailable</em>}</button>; })}</aside><div className="content-stack"><div className="panel operation-form"><div><small>Explore code</small><h2>{selected.label}</h2><details className="operation-technical"><summary>Technical operation</summary><code>{selected.id}</code></details></div>{operation === "core:discover_definitions" && <label><span>{selected.field}</span><input value={value} onChange={(event) => setValue(event.target.value)} placeholder="Search registry definitions…"/></label>}{fileOperation && <SearchableSelect label="Indexed file" choices={artifacts.choices} value={artifactPath} loading={artifacts.loading} placeholder="Search indexed files…" onChange={setArtifactPath}/>} {operation === "core:find_references" && <><SearchableSelect label="Indexed file" choices={artifacts.choices} value={artifactPath} loading={artifacts.loading} placeholder="Search indexed files…" onChange={(next) => { setArtifactPath(next); setValue(""); }}/><SearchableSelect label="Symbol" choices={symbols.choices} value={value} loading={symbols.loading} disabled={!artifactPath} placeholder="Search symbols by name, kind, or line…" onChange={setValue}/></>}<button className="button primary" disabled={!client || !workspaceId || (requiresValue && !effectiveValue.trim()) || loading || !availability.available} onClick={() => void run()}>{loading ? "Loading…" : "Browse indexed data"}</button>{!availability.available && <div className="operation-warning"><b>This operation is not ready</b><span>{availability.message}</span>{availability.reason_code && <code>{availability.reason_code}</code>}</div>}{(artifacts.error || symbols.error || error) && <p className="field-error">{error || symbols.error || artifacts.error}</p>}</div><ResultPage result={result} operation={operation} loading={loading} pageNumber={pageNumber} canPrevious={history.length > 0} loadingLabel={`Loading ${selected.label.toLocaleLowerCase()}`} onNext={(cursor) => void run(buildContinuationRequest(workspaceId, cursor), pageNumber + 1, true)} onPrevious={previousPage}/></div></section>;
}

function mergeGraphData(current: GraphData, next: GraphData): GraphData {
  const nodes = new Map([...current.nodes, ...next.nodes].map((node) => [node.id, node]));
  const edges = new Map([...current.edges, ...next.edges].map((edge) => [edge.id, edge]));
  return { nodes: [...nodes.values()], edges: [...edges.values()] };
}

function Graph({ client, tools, workspace }: { client?: Client | undefined; tools: Tool[]; workspace?: JsonRecord | undefined }): React.JSX.Element {
  const container = useRef<HTMLDivElement>(null); const graph = useRef<Core | undefined>(undefined);
  const [artifactPath, setArtifactPath] = useState(""); const [subject, setSubject] = useState(""); const [direction, setDirection] = useState("both"); const [depth, setDepth] = useState(1);
  const [result, setResult] = useState<unknown>(); const [data, setData] = useState<GraphData>({ nodes: [], edges: [] }); const [selected, setSelected] = useState<JsonRecord>(); const [error, setError] = useState(""); const [loading, setLoading] = useState(false);
  const workspaceId = String(workspace?.["workspace_id"] ?? ""); const freshness = shouldUseRetainedSnapshot(workspace) ? "current" : "wait"; const availability = operationAvailability(workspace, "core:expand_relations");
  const artifacts = useArtifactChoices(client, tools, workspace); const symbols = useSymbolChoices(client, tools, workspace, artifactPath); const selectedSymbol = symbols.choices.find((choice) => choice.value === subject);

  useEffect(() => () => graph.current?.destroy(), []);
  const renderGraph = async (nextData: GraphData): Promise<void> => {
    graph.current?.destroy();
    const { default: cytoscape } = await import("cytoscape");
    graph.current = cytoscape({
      container: container.current!, elements: [...nextData.nodes.map((node) => ({ data: { ...node, graphLabel: node.kind === undefined ? node.label : `${node.label}\n${node.kind}` } })), ...nextData.edges.map((edge) => ({ data: edge }))],
      style: [
        { selector: "node", style: { label: "data(graphLabel)", "background-color": "#766dec", color: "#292736", "font-size": 9, "font-weight": "bold", "text-valign": "bottom", "text-margin-y": 7, "text-wrap": "wrap", "text-max-width": "110px", "text-background-color": "#ffffff", "text-background-opacity": .88, "text-background-padding": "2px", width: 28, height: 28, "border-width": 2, "border-color": "#9f99ff", "border-opacity": .4 } },
        { selector: "node[kind = 'Root']", style: { "background-color": "#ed8267", width: 40, height: 40, "border-color": "#d85e42", "border-opacity": .65 } },
        { selector: "node:selected", style: { "border-color": "#171526", "border-opacity": 1, "border-width": 4, "text-background-opacity": 1 } },
        { selector: "edge", style: { label: "data(label)", color: "#505467", "font-size": 8, "text-background-color": "#ffffff", "text-background-opacity": .92, "text-background-padding": "2px", width: 1.5, "curve-style": "bezier", "target-arrow-shape": "triangle", "arrow-scale": .8, "line-color": "#74798a", "target-arrow-color": "#74798a", opacity: .72 } },
        { selector: "edge:selected", style: { width: 3, opacity: 1, "line-color": "#5548cf", "target-arrow-color": "#5548cf" } },
        { selector: "edge[classification = 'possible']", style: { "line-style": "dashed", opacity: .48 } },
      ],
      layout: { name: "cose", animate: false, padding: 58, nodeRepulsion: () => 8_000, idealEdgeLength: () => 125, edgeElasticity: () => 90, gravity: .28, numIter: 1_500 },
    });
    graph.current.on("tap", "node, edge", (event) => setSelected(event.target.data() as JsonRecord));
  };
  const runGraph = async (request?: JsonRecord, append = false): Promise<void> => {
    if (!client || !availability.available) return; setLoading(true); setError(""); setSelected(undefined);
    try {
      const initial = buildOperationRequest(workspaceId, "core:expand_relations", { subjects: [symbolSelectorForChoice(selectedSymbol, subject)], direction, relations: { evidence_class: "both" }, min_depth: 1, max_depth: depth, path_policy: "simple_subjects", filter: primaryArtifactFilter }, 30_000, freshness);
      const response = await callTool(client, tools, "urdira_query", request ?? initial); setResult(response);
      const pageData = graphDataFromPage(pageFromResult(response), selectedSymbol?.name ?? subject.trim()); const nextData = append ? mergeGraphData(data, pageData) : pageData;
      setData(nextData); await renderGraph(nextData); if (nextData.edges.length === 0) setError("No relationships were found for this exact symbol in the current structural index.");
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } finally { setLoading(false); }
  };
  const page = pageFromResult(result); const nextCursor = nextQueryCursor(result); const nodesById = new Map(data.nodes.map((node) => [node.id, node]));
  const resetGraph = (): void => { graph.current?.destroy(); graph.current = undefined; setResult(undefined); setData({ nodes: [], edges: [] }); setSelected(undefined); setError(""); };
  const zoomGraph = (factor: number): void => { if (!graph.current) return; graph.current.zoom(Math.max(.2, Math.min(4, graph.current.zoom() * factor))); graph.current.center(); };
  return <section className="graph-layout"><div className="panel graph-controls"><h2>Relationship graph</h2><p className="panel-intro">Choose an exact symbol, then follow who it calls, imports, contains, or depends on.</p>
    <SearchableSelect label="Indexed file" choices={artifacts.choices} value={artifactPath} loading={artifacts.loading} placeholder="Search indexed files…" onChange={(next) => { setArtifactPath(next); setSubject(""); resetGraph(); }}/>
    <SearchableSelect label="Starting symbol" choices={symbols.choices} value={subject} loading={symbols.loading} disabled={!artifactPath} placeholder="Search symbols by name, kind, or line…" onChange={(next) => { setSubject(next); resetGraph(); }}/>
    <label><span>Direction</span><select value={direction} onChange={(event) => setDirection(event.target.value)}><option value="both">Incoming and outgoing</option><option value="outbound">What this symbol uses</option><option value="inbound">What uses this symbol</option></select></label>
    <label><span>Relationship depth: {depth}</span><input type="range" min="1" max="5" value={depth} onChange={(event) => setDepth(Number(event.target.value))}/></label>
    <button className="button primary" disabled={!client || !workspaceId || !subject.trim() || loading || !availability.available} onClick={() => void runGraph()}>{loading ? "Building graph…" : "Expand relationships"}</button>
    {nextCursor && <button className="button secondary" disabled={loading} onClick={() => void runGraph(buildContinuationRequest(workspaceId, nextCursor), true)}>Load more relationships</button>}
    {loading && <div className="inline-progress" role="status"><span className="spinner"/><span>Resolving exact relationships and laying out readable labels…</span></div>}{!availability.available && <div className="operation-warning"><b>Relationship data is not ready</b><span>{availability.message}</span>{availability.reason_code && <code>{availability.reason_code}</code>}</div>}
    <div className="legend"><span><i className="root-dot"/>Starting symbol</span><span><i/>Confirmed</span><span><i className="possible-dot"/>Possible</span></div>{(artifacts.error || symbols.error || error) && <p className="field-error">{error || symbols.error || artifacts.error}</p>}<RawInspector value={result}/></div>
    <div className="graph-content"><div className="graph-stage panel"><div className="graph-notice"><span>{data.nodes.length} named nodes · {data.edges.length} relationships · Coverage {String(record(page["completeness_report"])["overall_status"] ?? "not reported")}</span>{nextCursor && <b>More relationships available</b>}</div><div className="graph-toolbar" aria-label="Graph controls"><button type="button" disabled={!graph.current} onClick={() => graph.current?.fit(undefined, 54)}>Fit</button><button type="button" disabled={!graph.current} aria-label="Zoom in" onClick={() => zoomGraph(1.22)}>+</button><button type="button" disabled={!graph.current} aria-label="Zoom out" onClick={() => zoomGraph(.82)}>−</button></div><div ref={container} className="graph-canvas"/>{selected ? <aside className="node-details"><h3>{String(selected["label"] ?? "Selection")}</h3>{typeof selected["path"] === "string" && <p>{selected["path"]}{typeof selected["line"] === "number" ? `:${selected["line"]}` : ""}</p>}<dl><dt>Type</dt><dd>{String(selected["kind"] ?? "Relationship")}</dd>{typeof selected["sourceLabel"] === "string" && <><dt>From</dt><dd>{selected["sourceLabel"]}</dd><dt>To</dt><dd>{String(selected["targetLabel"] ?? "Unknown target")}</dd></>}</dl><details><summary>Technical identifier</summary><code>{String(selected["id"] ?? "")}</code></details><button className="icon-button" onClick={() => setSelected(undefined)}>×</button></aside> : <div className="graph-empty">{data.edges.length > 0 ? "Select a named node or relationship for details." : "Choose a file and symbol, then expand its relationships."}</div>}</div>
      {data.edges.length > 0 && <section className="panel relation-table"><div className="section-heading compact"><div><h2>Relationships</h2><p>The same graph as a searchable, readable list.</p></div></div><div className="table-wrap"><table><thead><tr><th>From</th><th>Relationship</th><th>To</th><th>Evidence</th></tr></thead><tbody>{data.edges.map((edge) => { const source = nodesById.get(edge.source); const target = nodesById.get(edge.target); return <tr key={edge.id}><td><span className="relation-entity"><b>{edge.sourceLabel}</b><small>{[source?.kind, source?.path].filter(Boolean).join(" · ")}</small></span></td><td>{edge.label}</td><td><span className="relation-entity"><b>{edge.targetLabel}</b><small>{[target?.kind, target?.path].filter(Boolean).join(" · ")}</small></span></td><td><span className={`classification ${edge.classification ?? "confirmed"}`}>{edge.classification === "possible" ? "Possible" : "Confirmed"}</span></td></tr>; })}</tbody></table></div></section>}
    </div></section>;
}

function CliConsole({ workspaces, codebases }: { workspaces: JsonRecord[]; codebases: JsonRecord[] }): React.JSX.Element {
  const [commands, setCommands] = useState<JsonRecord[]>([]); const [selected, setSelected] = useState(""); const [argumentValues, setArgumentValues] = useState<Record<string, string>>({}); const [optionValues, setOptionValues] = useState<Record<string, string | boolean>>({}); const [result, setResult] = useState<unknown>(); const [loading, setLoading] = useState(false); const [error, setError] = useState("");
  useEffect(() => { void api("/api/v1/cli/commands").then((value) => { const list = Array.isArray(value["commands"]) ? value["commands"] as JsonRecord[] : []; setCommands(list); setSelected(String(list[0]?.["command"] ?? "")); }); }, []); const active = commands.find((entry) => entry["command"] === selected); const activeCommand = active as CliFormCommand | undefined; const args = Array.isArray(active?.["arguments"]) ? active["arguments"] as JsonRecord[] : []; const options = activeCommand === undefined ? [] : visibleCliOptions(activeCommand);
  const run = async (): Promise<void> => { setLoading(true); setError(""); try { const positional = args.map((entry) => argumentValues[String(entry["name"])] ?? "").filter(Boolean); const values = Object.fromEntries(Object.entries(optionValues).flatMap(([name, value]) => value === "" || value === false ? [] : [[name, name === "payload" && typeof value === "string" ? JSON.parse(value) : value]])); if (active?.["execution"] === "service_active") setResult({ status: "Already active in this web process" }); else if (active?.["confirmation"] === "none") setResult(await executeCli(selected, positional, values)); else { const proposal = await previewCli(selected, positional, values); setResult({ preview: proposal.result, result: await executeCli(selected, positional, values, proposal) }); } } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } finally { setLoading(false); } };
  const missing = args.some((entry) => entry["required"] === true && !(argumentValues[String(entry["name"])] ?? "").trim()); return <section className="tool-layout"><div className="panel tool-form"><label><span>Registered command</span><select value={selected} onChange={(event) => { setSelected(event.target.value); setArgumentValues({}); setOptionValues({}); setResult(undefined); }}>{commands.map((entry) => <option key={String(entry["command"])} value={String(entry["command"])}>{String(entry["label"])}</option>)}</select></label><p className="form-guidance">Fields with a fixed contract use selectable values. Paths, names, and JSON stay editable because their valid values depend on your workspace.</p><div className="generated-fields">{args.map((entry) => { const name = String(entry["name"]); const choices = cliFieldChoices(name, activeCommand ?? {}, workspaces, codebases); return <label key={name}><span>{name.replaceAll("_", " ")}{entry["required"] === true ? " *" : ""}</span>{choices.length > 0 ? <select value={argumentValues[name] ?? ""} onChange={(event) => setArgumentValues((current) => ({ ...current, [name]: event.target.value }))}><option value="">Choose {name.replaceAll("-", " ")}</option>{choices.map((choice) => <option key={choice.value} value={choice.value}>{choice.label}</option>)}</select> : <input value={argumentValues[name] ?? ""} placeholder={String(entry["description"])} onChange={(event) => setArgumentValues((current) => ({ ...current, [name]: event.target.value }))}/>}</label>; })}{options.map((name) => { const choices = cliFieldChoices(name, activeCommand ?? {}, workspaces, codebases); const defaultLabel = name === "client" && selected !== "agent-hook" ? "Default: all supported clients" : name === "scope" ? "Default: user configuration" : `Choose ${name.replaceAll("-", " ")}`; return ["debug-timing", "require-git-clean"].includes(name) ? <label className="checkbox" key={name}><input type="checkbox" checked={optionValues[name] === true} onChange={(event) => setOptionValues((current) => ({ ...current, [name]: event.target.checked }))}/><span>{name}</span></label> : <label key={name}><span>{name.replaceAll("-", " ")}</span>{name === "payload" ? <textarea value={String(optionValues[name] ?? "")} placeholder="Optional JSON payload" onChange={(event) => setOptionValues((current) => ({ ...current, [name]: event.target.value }))}/> : choices.length > 0 ? <><select value={String(optionValues[name] ?? "")} onChange={(event) => setOptionValues((current) => ({ ...current, [name]: event.target.value }))}><option value="">{defaultLabel}</option>{choices.map((choice) => <option key={choice.value} value={choice.value}>{choice.label}</option>)}</select><small className="field-hint">Only values accepted by this command are shown.</small></> : <input value={String(optionValues[name] ?? "")} onChange={(event) => setOptionValues((current) => ({ ...current, [name]: event.target.value }))}/>}</label>; })}</div><button className="button primary" disabled={missing || loading} onClick={() => void run()}>{loading ? "Running…" : active?.["confirmation"] === "destructive" ? "Preview and confirm" : "Run command"}</button>{error && <p className="field-error">{error}</p>}<RawInspector value={active?.["input_schema"]} label="Advanced / Command schema"/></div><div className="panel visual-output"><h2>Command result</h2>{loading ? <QueryProgress label={`Running ${String(active?.["label"] ?? "command")}`}/> : result === undefined ? <div className="state-card empty-state"><b>No command run</b><span>Results appear here as a readable table or tree.</span></div> : <StructuredView value={result}/>}<RawInspector value={result}/></div></section>;
}

interface McpPreset { readonly id: string; readonly label: string; readonly help: string; readonly request: JsonRecord }

function mcpToolDefaults(name: string, schema: unknown, workspaceId: string): JsonRecord {
  const scopeId = workspaceId || "<select a workspace>";
  if (name === "urdira_index_status") return { workspace_ids: workspaceId ? [workspaceId] : [] };
  if (name === "urdira_query") return buildOperationRequest(scopeId, "core:find_artifacts", { filter: primaryArtifactFilter });
  const generated = record(initialSchemaValue(schema));
  if (record(schema)["properties"] !== undefined && record(record(schema)["properties"])["scope"] !== undefined) generated["scope"] = { scope_type: "single_workspace", workspace_id: scopeId };
  return generated;
}

function queryMcpPresets(workspaceId: string): readonly McpPreset[] {
  const scopeId = workspaceId || "<select a workspace>";
  return [
    { id: "files", label: "Browse files", help: "List primary indexed source files.", request: buildOperationRequest(scopeId, "core:find_artifacts", { filter: primaryArtifactFilter }) },
    { id: "text", label: "Exact text", help: "Find a literal string in indexed source.", request: buildOperationRequest(scopeId, "core:search_text", { pattern: "TODO", syntax: "literal", case_sensitive: false, word_mode: "substring", result_projection: "match" }) },
    { id: "semantic", label: "Search by intent", help: "Describe behavior instead of guessing a symbol.", request: buildOperationRequest(scopeId, "core:search_semantic", { query_text: "where authentication is handled", query_class: "mixed" }) },
    { id: "source", label: "Read a file", help: "Retrieve indexed source for a known path.", request: buildOperationRequest(scopeId, "core:get_source", { subjects: [{ subject_type: "artifact", path: "README.md" }], source: { mode: "body", max_characters_per_snippet: 20_000, max_total_characters: 40_000, context_lines: 2 } }) },
    { id: "references", label: "Find references", help: "Resolve usages of a known symbol name.", request: buildOperationRequest(scopeId, "core:find_references", { target: { subject_type: "symbol", name: "App" }, include_declarations: true, filter: primaryArtifactFilter }) },
    { id: "architecture", label: "Architecture", help: "Inspect entry points and code boundaries.", request: buildOperationRequest(scopeId, "core:inspect_architecture", explorerArgs("core:inspect_architecture", "")) },
  ];
}

function McpConsole({ client, tools, workspaceId }: { client?: Client | undefined; tools: Tool[]; workspaceId: string }): React.JSX.Element {
  const [name, setName] = useState("urdira_index_status");
  const active = tools.find((entry) => entry.name === name) ?? tools[0];
  const activeName = active?.name ?? name;
  const defaults = useMemo<JsonRecord>(() => mcpToolDefaults(activeName, active?.inputSchema, workspaceId), [activeName, active?.inputSchema, workspaceId]);
  const [request, setRequest] = useState<JsonRecord>(defaults);
  const [raw, setRaw] = useState(() => JSON.stringify(defaults, null, 2));
  const [editor, setEditor] = useState<"guided" | "json">("guided");
  const [jsonError, setJsonError] = useState("");
  const [result, setResult] = useState<unknown>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  useEffect(() => { setRequest(defaults); setRaw(JSON.stringify(defaults, null, 2)); setJsonError(""); setError(""); }, [defaults]);
  const setGuidedRequest = (next: JsonRecord): void => { setRequest(next); setRaw(JSON.stringify(next, null, 2)); setJsonError(""); };
  const setManualRequest = (next: string): void => {
    setRaw(next);
    try { const parsed = parseMcpRequest(next); setRequest(parsed); setJsonError(""); }
    catch (reason) { setJsonError(reason instanceof Error ? reason.message : String(reason)); }
  };
  const schemaErrors = validateMcpRequest(request, active?.inputSchema ?? {});
  const presets = activeName === "urdira_query" ? queryMcpPresets(workspaceId) : [];
  const pipelineExamples = activeName === "urdira_query" ? pipelineMcpExamples(workspaceId) : [];
  const pipeline = pipelinePresentation(request);
  const operation = String(record(record(request["query"])["expression"])["operation"] ?? "");
  const run = async (): Promise<void> => {
    if (!client || !active) return;
    setError(""); setLoading(true);
    try {
      const parsed = parseMcpRequest(raw); const errors = validateMcpRequest(parsed, active.inputSchema);
      if (errors.length > 0) throw new Error(errors.join(" "));
      setResult(await callTool(client, tools, activeName, parsed));
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setLoading(false); }
  };
  return <section className="mcp-console">
    <div className="panel mcp-composer">
      <div className="mcp-tool-heading"><label><span>Agent tool</span><select value={activeName} onChange={(event) => { setName(event.target.value); setResult(undefined); }}>{tools.map((tool) => <option key={tool.name} value={tool.name}>{tool.name.replace(/^urdira_/u, "").replaceAll("_", " ")}</option>)}</select></label><div className="scope-callout"><span>Explicit workspace scope</span><b>{workspaceId || "Select a workspace above"}</b></div></div>
      <p className="tool-description">{active?.description}</p>
      {presets.length > 0 && <div className="mcp-presets"><div><b>Start from a common query</b><span>Load a valid request, then adjust any field below.</span></div><div className="mcp-preset-grid">{presets.map((preset) => <button type="button" key={preset.id} onClick={() => { setGuidedRequest(preset.request); setResult(undefined); }}><b>{preset.label}</b><span>{preset.help}</span></button>)}</div></div>}
      {pipelineExamples.length > 0 && <section className="pipeline-guide" aria-labelledby="pipeline-guide-title"><div className="pipeline-guide-heading"><div><span className="eyebrow">Urdira pipelines</span><b id="pipeline-guide-title">Let one result drive the next query</b><p>A pipeline sends the complete output set from one stage into a named argument of another. No copying opaque identifiers, no client-side loops.</p></div><details><summary>How bindings work</summary><ol><li>Give every stage a stable <code>stage_id</code>.</li><li>Choose a registered output from the upstream operation.</li><li>Map the downstream argument to <code>{`{ stage_id, output }`}</code> in <code>bindings</code>.</li><li>Expose only the final streams you need in <code>outputs</code>.</li></ol><p>Scalar arguments require exactly one upstream result; set-valued arguments consume the complete logical set.</p></details></div><div className="pipeline-example-grid">{pipelineExamples.map((example) => <article key={example.id} className="pipeline-example"><div><b>{example.label}</b><p>{example.help}</p></div>{example.bindings.map((binding) => <div className="pipeline-flow" key={`${binding.to_stage}:${binding.argument}`}><span>{binding.from_stage}<code>.{binding.output}</code></span><i aria-hidden="true">→</i><span>{binding.to_stage}<code>.{binding.argument}</code></span></div>)}<small>{example.outcome}</small><button type="button" className="button secondary" onClick={() => { setGuidedRequest(example.request); setResult(undefined); }}>Load this pipeline</button></article>)}</div></section>}
      <div className="editor-tabs" role="tablist" aria-label="MCP request editor"><button type="button" role="tab" aria-selected={editor === "guided"} className={editor === "guided" ? "active" : ""} onClick={() => setEditor("guided")}>Guided builder</button><button type="button" role="tab" aria-selected={editor === "json"} className={editor === "json" ? "active" : ""} onClick={() => setEditor("json")}>Manual JSON</button></div>
      {pipeline && <div className="pipeline-anatomy" role="status"><div className="pipeline-anatomy-heading"><div><span className="eyebrow">Loaded pipeline</span><b>{pipeline.stages.length} dependent stages</b></div><span>{pipeline.outputs.length} returned stream{pipeline.outputs.length === 1 ? "" : "s"}</span></div><div className="pipeline-stage-row">{pipeline.stages.map((stage, index) => <React.Fragment key={stage.stage_id}>{index > 0 && <span className="pipeline-arrow" aria-hidden="true">→</span>}<div className="pipeline-stage"><small>{stage.stage_id}</small><b>{stage.label}</b><code>{stage.operation}</code>{pipeline.bindings.filter((binding) => binding.to_stage === stage.stage_id).map((binding) => <span key={`${binding.argument}:${binding.from_stage}`}>{binding.argument} ← {binding.from_stage}.{binding.output}</span>)}</div></React.Fragment>)}</div><div className="pipeline-outputs"><span>Returns</span>{pipeline.outputs.map((output) => <code key={output.name}>{output.name} ← {output.stage_id}.{output.output}</code>)}</div></div>}
      <div className="mcp-editor">{editor === "guided" ? <McpRequestBuilder schema={active?.inputSchema ?? { type: "object" }} value={request} onChange={setGuidedRequest}/> : <label className="manual-request"><span>Request parameters</span><textarea className="raw-editor" value={raw} spellCheck={false} onChange={(event) => setManualRequest(event.target.value)}/><small>Edit the exact JSON object sent to the selected MCP tool. Valid JSON is reflected immediately in the guided builder.</small></label>}</div>
      {(jsonError || schemaErrors.length > 0) && <div className="request-validation" role="alert"><b>Request needs attention</b><ul>{jsonError ? <li>{jsonError}</li> : schemaErrors.slice(0, 6).map((message) => <li key={message}>{message}</li>)}</ul></div>}
      <div className="mcp-call-bar"><div><small>Ready to call</small><b>{activeName}</b></div><button className="button primary" disabled={!client || !workspaceId || loading || Boolean(jsonError) || schemaErrors.length > 0} onClick={() => void run()}>{loading ? "Calling tool…" : "Run MCP request"}</button></div>
      {error && <p className="field-error">{error}</p>}
      <details className="raw-inspector"><summary>Technical input schema</summary><RawInspector value={active?.inputSchema} label="Advertised schema"/></details>
    </div>
    <div className="panel visual-output mcp-output"><div className="section-heading compact"><div><h2>Tool result</h2><p>Structured exactly as returned by the local MCP server.</p></div></div>{loading ? <QueryProgress label={`Calling ${activeName}`}/> : activeName === "urdira_query" ? <ResultPage result={result} operation={operation}/> : result === undefined ? <div className="state-card empty-state"><b>No request run yet</b><span>Build a request on the left, then run it to inspect the structured response.</span></div> : <StructuredView value={record(record(result)["structuredContent"])["page"] ?? result}/>}<RawInspector value={result}/></div>
  </section>;
}

createRoot(document.getElementById("root")!).render(<App/>);
