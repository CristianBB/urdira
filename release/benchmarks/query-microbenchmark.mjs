#!/usr/bin/env node
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { execFileSync } from "node:child_process";
import { extractQueryTelemetry } from "./query-micro-telemetry.mjs";

const args = process.argv.slice(2),
  get = (n, d = null) => {
    const i = args.indexOf(n);
    return i < 0 ? d : args[i + 1];
  };
const reposRoot = resolve(get("--repositories-root"));
const output = resolve(get("--output-dir"));
const node = get("--node", process.execPath);
const worker = get(
  "--indexing-worker",
  join(process.cwd(), "target/release/urdira-indexing-worker"),
);
const repos = get("--repositories", "typescript,playwright,prisma,vscode")
  .split(",")
  .filter(Boolean);
const operations = new Set(
  (get("--operations", "") || "").split(",").filter(Boolean),
);
const searchSyntax = get("--search-syntax", "");
const symbols = {
  typescript: "transpileModule",
  playwright: "affectedTestFiles",
  prisma: "MongoValueSet",
  vscode: "LanguageFeatureRegistry",
};
mkdirSync(output, { recursive: true });
const env = {
  ...process.env,
  URDIRA_SEMANTIC_INDEX: "0",
  URDIRA_SEMANTIC_MATERIALIZATION: "0",
  URDIRA_SEMANTIC_SIDECAR: "0",
  URDIRA_ANALYSIS_WORKERS: "1",
  URDIRA_ANALYSIS_POOL_MAX: "1",
  URDIRA_STRUCTURAL_CONCURRENCY: "1",
  URDIRA_RECONCILIATION_SWEEP_INTERVAL_MS: "0",
  URDIRA_DEBUG_TIMING: "1",
  URDIRA_STORAGE_DEBUG_TIMING: "1",
  URDIRA_V4_DEBUG_SEMANTIC_PERF: "1",
  URDIRA_INDEXING_CORE_WORKER_PATH: worker,
};
const jsonResult = (x) => {
  if (x?.structuredContent) return x.structuredContent;
  if (x?.structured_content) return x.structured_content;
  for (const p of x?.content ?? []) {
    if (p.type !== "text") continue;
    try {
      return JSON.parse(p.text);
    } catch {
      const m = p.text.match(/MORE:\s+pass cursor\s+([^\s]+)/);
      if (m) {
        const lines = p.text
            .split(/\r?\n/)
            .map((s) => s.trim())
            .filter(Boolean),
          i = lines.findIndex((s) => s.startsWith("MORE:")),
          encoded = lines.slice(i + 1).find((s) => s.length > 100);
        return { _compact_text: p.text, _cursor: encoded ?? m[1] };
      }
      return { _compact_text: p.text };
    }
  }
  return x;
};
async function runRepo(id) {
  const sourceRoot = join(reposRoot, id),
    worktree = join("/tmp", `urdira-query-micro-wt-${id}-${randomUUID()}`),
    data = join("/tmp", `urdira-query-micro-v1-${id}`);
  const commits = {
    typescript: "b465fdbfe175304d9b977da137b2c178ae1091d3",
    playwright: "1b44f5a441f391538c42c7ce36dd8ce779a5d6a",
    prisma: "0f37454eec96b193e8b20e8f569e453acd2af644",
    vscode: "038b9225c82c6b75172beda6081c64887692538c",
  };
  rmSync(worktree, { recursive: true, force: true });
  rmSync(data, { recursive: true, force: true });
  try {
    execFileSync("git", ["-C", sourceRoot, "worktree", "prune"], {
      stdio: "ignore",
    });
  } catch (error) {
    if (error?.code !== "ENOENT")
      process.stderr.write(`worktree prune failed: ${String(error)}\n`);
  }
  execFileSync(
    "git",
    ["-C", sourceRoot, "worktree", "add", "--detach", worktree, commits[id]],
    { stdio: "ignore" },
  );
  try {
    const tracked = Number(
      execFileSync("git", ["-C", worktree, "ls-files"], {
        encoding: "utf8",
        maxBuffer: 20_000_000,
      })
        .trim()
        .split("\n")
        .filter(Boolean).length,
    );
    if (tracked <= 1000 || !readFileSync(join(worktree, "package.json")))
      throw new Error(`${id}: checkout validation failed tracked=${tracked}`);
    const transport = new StdioClientTransport({
      command: node,
      args: [
        join(process.cwd(), "release/benchmarks/query-micro-mcp-entry.mjs"),
      ],
      env: {
        ...env,
        URDIRA_DATA_ROOT: data,
        URDIRA_MICRO_REPOSITORY: worktree,
      },
      stderr: "pipe",
    });
    const stderr = [];
    transport.stderr?.on("data", (chunk) => stderr.push(chunk.toString()));
    const c = new Client(
      { name: "urdira-query-microbenchmark", version: "1" },
      { requestTimeout: 120000 },
    );
    const telemetry = [];
    let progressSequence = 0;
    c.setNotificationHandler("notifications/progress", (notification) => {
      const event = extractQueryTelemetry(notification);
      if (event !== undefined) telemetry.push(event);
    });
    await c.connect(transport);
    const rows = [];
    const persist = () =>
      writeFileSync(
        join(output, `raw-${id}.json`),
        JSON.stringify(
          {
            repository: id,
            worktree,
            stderr: stderr.join(""),
            rows,
            telemetry,
          },
          null,
          2,
        ),
      );
    const call = async (label, name, arguments_) => {
      const t = performance.now();
      let result, error;
      const telemetryBefore = readCapturedTelemetry().length;
      try {
        result = jsonResult(
          await c.callTool({
            name,
            arguments: arguments_,
            _meta: { progressToken: ++progressSequence },
          }),
        );
      } catch (e) {
        error = String(e);
      }
      rows.push({
        label,
        wall_ms: performance.now() - t,
        result,
        error,
        telemetry: readCapturedTelemetry().slice(telemetryBefore),
      });
      persist();
      return result;
    };
    const telemetryPath = join(data, "micro-telemetry.jsonl");
    const readCapturedTelemetry = () => {
      try {
        return readFileSync(telemetryPath, "utf8")
          .split(/\r?\n/)
          .filter(Boolean)
          .map((line) => extractQueryTelemetry(JSON.parse(line)))
          .filter(Boolean);
      } catch (error) {
        if (error?.code !== "ENOENT")
          process.stderr.write(`telemetry read failed: ${String(error)}\n`);
        return [];
      }
    };
    const bootstrap = join(data, "micro-bootstrap.json");
    const bootstrapDeadline = Date.now() + 1800000;
    while (!existsSync(bootstrap) && Date.now() < bootstrapDeadline)
      await sleep(250);
    if (!existsSync(bootstrap))
      throw new Error(`${id}: bootstrap/readiness artifact missing`);
    const scope = JSON.parse(readFileSync(bootstrap, "utf8")).query_scope;
    if (!scope?.workspace_id)
      throw new Error(`${id}: bootstrap query_scope missing`);
    const q = (
      operation,
      arguments_,
      budget = { max_items: 100, max_characters: 20000 },
    ) => ({
      request_type: "query",
      query: {
        api_version: 3,
        scope,
        expression: {
          expression_type: "operation",
          operation,
          arguments: arguments_,
        },
        options: { response_budget: budget },
      },
    });
    const cont = (cursor) => ({
      request_type: "continuation",
      continuation: {
        api_version: 3,
        scope,
        cursor,
        response_budget: { max_items: 100, max_characters: 20000 },
      },
    });
    if (!operations.size || operations.has("resolve_symbol"))
      await call(
        "resolve-context",
        "urdira_query",
        q("core:resolve_symbol", {
          reference: symbols[id],
          resolution_scope: "workspace",
          context_artifact: "package.json",
        }),
      );
    if (!operations.size || operations.has("resolve_symbol"))
      await call(
        "resolve-qualified",
        "urdira_query",
        q("core:resolve_symbol", {
          reference: symbols[id],
          resolution_scope: "exports",
        }),
      );
    if (!operations.size || operations.has("resolve_symbol"))
      await call(
        "resolve-kind",
        "urdira_query",
        q("core:resolve_symbol", {
          reference: symbols[id],
          resolution_scope: "workspace",
          kind_selector: { universal_kinds: ["core:callable"] },
        }),
      );
    let r =
      operations.size && !operations.has("find_records")
        ? null
        : await call(
            "find-records-page-1",
            "urdira_query",
            q("core:find_records", {
              selector: { record_categories: ["entity"] },
            }),
          );
    let cursor = r?.cursor ?? r?.continuation?.cursor ?? r?._cursor;
    if (cursor) await call("find-records-page-2", "urdira_query", cont(cursor));
    if (!operations.size || operations.has("search_text"))
      for (const [label, syntax, pattern] of [
        ["search-literal", "literal", symbols[id]],
        [
          "search-safe-regex",
          "safe_regex",
          symbols[id].replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        ],
      ].filter((entry) => searchSyntax === "" || entry[1] === searchSyntax)) {
        r = await call(
          label + "-page-1",
          "urdira_query",
          q("core:search_text", {
            pattern,
            syntax,
            word_mode: "substring",
            result_projection: "artifact",
          }),
        );
        cursor = r?.cursor ?? r?.continuation?.cursor ?? r?._cursor;
        if (cursor) await call(label + "-page-2", "urdira_query", cont(cursor));
      }
    if (!operations.size || operations.has("wide"))
      await call(
        "wide-continuation-error",
        "urdira_query",
        q(
          "core:find_records",
          {
            selector: {
              record_categories: ["entity", "diagnostic", "relation"],
            },
          },
          { max_items: 1, max_characters: 1000 },
        ),
      );
    await c.close();
    await transport.close().catch(() => {});
    persist();
    return { repository: id, worktree, rows, telemetry };
  } finally {
    try {
      execFileSync(
        "git",
        ["-C", sourceRoot, "worktree", "remove", "--force", worktree],
        { stdio: "pipe" },
      );
    } catch (error) {
      if (error?.code !== "ENOENT")
        process.stderr.write(`worktree remove failed: ${String(error)}\n`);
    }
    for (let attempt = 0; attempt < 5 && existsSync(worktree); attempt++) {
      try {
        rmSync(worktree, { recursive: true, force: true });
      } catch (error) {
        if (error?.code !== "ENOENT")
          process.stderr.write(`worktree cleanup failed: ${String(error)}\n`);
      }
      if (existsSync(worktree)) await sleep(200);
    }
    for (let attempt = 0; attempt < 5 && existsSync(data); attempt++) {
      try {
        rmSync(data, { recursive: true, force: true });
      } catch (error) {
        if (error?.code !== "ENOENT")
          process.stderr.write(`data cleanup failed: ${String(error)}\n`);
      }
      if (existsSync(data)) await sleep(200);
    }
  }
}
const all = [];
for (const id of repos) {
  try {
    all.push(await runRepo(id));
  } catch (error) {
    all.push({ repository: id, error: String(error), rows: [] });
  }
}
writeFileSync(
  join(output, "results.json"),
  JSON.stringify(
    {
      schema_version: 1,
      semantic_index: false,
      semantic_materialization: false,
      runs: all,
    },
    null,
    2,
  ),
);
