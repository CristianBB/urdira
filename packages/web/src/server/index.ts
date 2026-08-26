import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { CLI_COMMAND_CATALOG, type CliCommandDescriptor, type CliResult } from "@urdira/cli";
import { createUrdiraMcpHttpHandler, type UrdiraMcpClient } from "@urdira/mcp";

const HOST = "127.0.0.1";
const MAX_BODY_BYTES = 1_048_576;
const API_VERSION = 1 as const;

export interface StartUrdiraWebOptions {
  readonly client: UrdiraMcpClient;
  readonly run_cli: (argv: readonly string[], on_progress?: (progress: unknown) => void) => Promise<CliResult>;
  readonly port?: number;
  readonly initial_directory?: string;
}

export interface UrdiraWebHandle {
  readonly url: string;
  readonly origin: string;
  readonly close: () => Promise<void>;
}

interface CliApiRequest {
  readonly api_version: 1;
  readonly command: string;
  readonly args: readonly string[];
  readonly options: Readonly<Record<string, string | boolean | number | object>>;
  readonly proposal_id?: string;
  readonly proposal_digest?: string;
}

interface StoredProposal { readonly digest: string; readonly request: CliApiRequest; readonly result: CliResult }
interface StoredOperation { readonly operation_id: string; readonly command: string; status: "running" | "completed" | "failed"; result?: CliResult; error?: string; events: unknown[]; listeners: Set<(event: unknown) => void> }

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(value));
}

function apiError(response: ServerResponse, status: number, code: string, message: string): void {
  json(response, status, { api_version: API_VERSION, error: { code, message } });
}

function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }

async function body(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > MAX_BODY_BYTES) throw new Error("web:body_too_large");
    chunks.push(buffer);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new Error("web:json_invalid"); }
}

function parseCliRequest(value: unknown): CliApiRequest {
  if (!isRecord(value) || value["api_version"] !== API_VERSION || typeof value["command"] !== "string" || !Array.isArray(value["args"]) || value["args"].some((entry) => typeof entry !== "string") || !isRecord(value["options"])) throw new Error("web:cli_request_invalid");
  const allowed = new Set(["api_version", "command", "args", "options", "proposal_id", "proposal_digest"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new Error("web:cli_request_invalid");
  if (value["proposal_id"] !== undefined && typeof value["proposal_id"] !== "string") throw new Error("web:cli_request_invalid");
  if (value["proposal_digest"] !== undefined && typeof value["proposal_digest"] !== "string") throw new Error("web:cli_request_invalid");
  return value as unknown as CliApiRequest;
}

function commandDescriptor(request: CliApiRequest): CliCommandDescriptor {
  const descriptor = CLI_COMMAND_CATALOG.find((entry) => entry.command === request.command);
  if (descriptor === undefined || descriptor.execution === "service_active") throw new Error("web:command_not_executable");
  if (request.args.length < descriptor.arguments.filter((entry) => entry.required).length) throw new Error("web:arguments_invalid");
  const allowedOptions = new Set(descriptor.options);
  if (Object.keys(request.options).some((key) => !allowedOptions.has(key))) throw new Error("web:option_not_registered");
  return descriptor;
}

function cliArgv(request: CliApiRequest, mode: "preview" | "execute", descriptor: CliCommandDescriptor): string[] {
  const argv = [request.command, ...request.args];
  for (const [name, value] of Object.entries(request.options)) {
    if (name === "dry-run" || name === "confirm" || name === "json") continue;
    if (typeof value === "boolean") {
      if (value) argv.push(`--${name}`);
      continue;
    }
    argv.push(`--${name}`, typeof value === "object" ? JSON.stringify(value) : String(value));
  }
  if (mode === "preview" && descriptor.execution === "administrative") argv.push("--dry-run");
  if (mode === "execute" && descriptor.execution === "administrative" && descriptor.confirmation !== "none") argv.push("--confirm");
  argv.push("--json");
  return argv;
}

function proposalDigest(request: CliApiRequest, result: CliResult): string {
  return `sha256:${createHash("sha256").update(JSON.stringify({ command: request.command, args: request.args, options: request.options, result: result.data })).digest("hex")}`;
}

function mime(path: string): string {
  return ({ ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".json": "application/json; charset=utf-8" } as Record<string, string>)[extname(path)] ?? "application/octet-stream";
}

async function writeFetchResponse(target: ServerResponse, source: Response): Promise<void> {
  const headers = Object.fromEntries(source.headers.entries());
  target.writeHead(source.status, { ...headers, "cache-control": "no-store" });
  if (source.body === null) { target.end(); return; }
  await new Promise<void>((resolvePromise, reject) => {
    const stream = Readable.fromWeb(source.body as import("node:stream/web").ReadableStream);
    stream.once("error", reject);
    target.once("finish", resolvePromise);
    stream.pipe(target);
  });
}

export async function startUrdiraWeb(options: StartUrdiraWebOptions): Promise<UrdiraWebHandle> {
  const proposals = new Map<string, StoredProposal>();
  const operations = new Map<string, StoredOperation>();
  const mcp = createUrdiraMcpHttpHandler({ client: options.client });
  const clientRoot = fileURLToPath(new URL("../client/", import.meta.url));
  let origin = "";

  const server = createServer(async (req, res) => {
    res.setHeader("referrer-policy", "no-referrer");
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("content-security-policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    try {
      const host = req.headers.host;
      if (host !== new URL(origin).host) { apiError(res, 400, "web:host_invalid", "The Host header is not the active loopback listener."); return; }
      const requestOrigin = req.headers.origin;
      if (requestOrigin !== undefined && requestOrigin !== origin) { apiError(res, 403, "web:origin_invalid", "Cross-origin requests are not allowed."); return; }
      const url = new URL(req.url ?? "/", origin);

      if (url.pathname === "/mcp") {
        if (!["GET", "POST", "DELETE"].includes(req.method ?? "")) { apiError(res, 405, "web:method_not_allowed", "Method not allowed."); return; }
        if (req.method === "POST" && !(req.headers["content-type"] ?? "").toString().toLowerCase().startsWith("application/json")) { apiError(res, 415, "web:content_type_invalid", "MCP POST requests require application/json."); return; }
        const raw = req.method === "POST" ? Buffer.from(JSON.stringify(await body(req))) : undefined;
        const request = new Request(url, { method: req.method ?? "GET", headers: new Headers(Object.entries(req.headers).flatMap(([key, value]) => value === undefined ? [] : [[key, Array.isArray(value) ? value.join(", ") : value]])), ...(raw === undefined ? {} : { body: raw }) });
        await writeFetchResponse(res, await mcp.fetch(request));
        return;
      }

      if (url.pathname === "/api/v1/cli/commands" && req.method === "GET") { json(res, 200, { api_version: API_VERSION, commands: CLI_COMMAND_CATALOG }); return; }
      if (url.pathname === "/api/v1/cli/preview" && req.method === "POST") {
        const request = parseCliRequest(await body(req));
        const descriptor = commandDescriptor(request);
        const result = await options.run_cli(cliArgv(request, "preview", descriptor));
        const proposal_id = `web-proposal:${randomUUID()}`;
        const proposal_digest = proposalDigest(request, result);
        proposals.set(proposal_id, { digest: proposal_digest, request, result });
        json(res, 200, { api_version: API_VERSION, proposal_id, proposal_digest, result });
        return;
      }
      if (url.pathname === "/api/v1/cli/execute" && req.method === "POST") {
        const request = parseCliRequest(await body(req));
        const descriptor = commandDescriptor(request);
        if (descriptor.confirmation !== "none") {
          const proposal = request.proposal_id === undefined ? undefined : proposals.get(request.proposal_id);
          if (proposal === undefined || request.proposal_digest !== proposal.digest || proposal.request.command !== request.command || JSON.stringify(proposal.request.args) !== JSON.stringify(request.args) || JSON.stringify(proposal.request.options) !== JSON.stringify(request.options)) throw new Error("web:proposal_invalid");
          proposals.delete(request.proposal_id!);
        }
        const operation_id = `operation:${randomUUID()}`;
        const operation: StoredOperation = { operation_id, command: request.command, status: "running", events: [], listeners: new Set() };
        operations.set(operation_id, operation);
        const progress = (value: unknown): void => { const event = { type: "progress", operation_id, progress: value }; operation.events.push(event); for (const listener of operation.listeners) listener(event); };
        void options.run_cli(cliArgv(request, "execute", descriptor), progress).then((result) => {
          operation.status = "completed"; operation.result = result;
          for (const listener of operation.listeners) listener({ type: "completed", operation_id, result });
          operation.listeners.clear();
        }, (error: unknown) => {
          operation.status = "failed"; operation.error = error instanceof Error ? error.message : String(error);
          for (const listener of operation.listeners) listener({ type: "failed", operation_id, error: operation.error });
          operation.listeners.clear();
        });
        json(res, 202, { api_version: API_VERSION, operation_id, status: operation.status });
        return;
      }
      const operationMatch = /^\/api\/v1\/cli\/operations\/([^/]+)\/events$/u.exec(url.pathname);
      if (operationMatch && req.method === "GET") {
        const operation = operations.get(decodeURIComponent(operationMatch[1]!));
        if (operation === undefined) { apiError(res, 404, "web:operation_not_found", "Operation not found."); return; }
        res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", connection: "keep-alive" });
        const send = (event: unknown): void => { res.write(`data: ${JSON.stringify(event)}\n\n`); if (isRecord(event) && (event["type"] === "completed" || event["type"] === "failed")) res.end(); };
        if (operation.status === "running") { send({ type: "running", operation_id: operation.operation_id }); for (const event of operation.events) send(event); operation.listeners.add(send); req.once("close", () => operation.listeners.delete(send)); }
        else { for (const event of operation.events) send(event); send({ type: operation.status, operation_id: operation.operation_id, ...(operation.result === undefined ? {} : { result: operation.result }), ...(operation.error === undefined ? {} : { error: operation.error }) }); }
        return;
      }
      const cancelMatch = /^\/api\/v1\/cli\/operations\/([^/]+)$/u.exec(url.pathname);
      if (cancelMatch && req.method === "DELETE") { apiError(res, 409, "web:operation_not_cancellable", "The registered command does not permit cancellation."); return; }
      if (url.pathname === "/api/v1/directories" && req.method === "GET") {
        const requested = url.searchParams.get("path") ?? options.initial_directory ?? homedir();
        const directory = await realpath(requested);
        if (!(await stat(directory)).isDirectory()) throw new Error("web:directory_invalid");
        const entries = await readdir(directory, { withFileTypes: true });
        const directories = entries.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink()).map((entry) => ({ name: entry.name, path: join(directory, entry.name) })).sort((left, right) => left.name.localeCompare(right.name));
        json(res, 200, { api_version: API_VERSION, directory, parent: resolve(directory, ".."), directories });
        return;
      }
      if (url.pathname.startsWith("/api/") || url.pathname === "/mcp") { apiError(res, 404, "web:route_not_found", "Route not found."); return; }
      if (req.method !== "GET" && req.method !== "HEAD") { apiError(res, 405, "web:method_not_allowed", "Method not allowed."); return; }
      const relative = url.pathname === "/" ? "index.html" : normalize(url.pathname).replace(/^\/+/, "");
      if (relative.startsWith("..")) { apiError(res, 404, "web:asset_not_found", "Asset not found."); return; }
      const path = join(clientRoot, relative);
      const selected = await stat(path).then((entry) => entry.isFile() ? path : join(clientRoot, "index.html")).catch(() => join(clientRoot, "index.html"));
      res.writeHead(200, { "content-type": mime(selected), "cache-control": selected.endsWith("index.html") ? "no-store" : "public, max-age=31536000, immutable" });
      if (req.method === "HEAD") res.end(); else createReadStream(selected).pipe(res);
    } catch (error) {
      const code = error instanceof Error ? error.message : "web:internal";
      const status = code === "web:body_too_large" ? 413 : code.includes("invalid") || code.includes("not_") ? 400 : 500;
      apiError(res, status, code.startsWith("web:") ? code : "web:internal", code.startsWith("web:") ? code : "The local web request failed.");
    }
  });

  await new Promise<void>((resolvePromise, reject) => { server.once("error", reject); server.listen(options.port ?? 0, HOST, () => resolvePromise()); });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("web:listener_invalid");
  origin = `http://${HOST}:${address.port}`;
  return {
    origin,
    url: `${origin}/`,
    close: async () => { await mcp.close(); await new Promise<void>((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise())); },
  };
}
