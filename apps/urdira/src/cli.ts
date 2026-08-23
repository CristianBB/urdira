#!/usr/bin/env node
import { fork } from "node:child_process";
import { mkdir, open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseCliArgs, type CliResult } from "@urdira/cli";
import type { DaemonStartupPhase } from "@urdira/daemon";
import { migrateToV3 } from "@urdira/storage";
import { runUrdira, runUrdiraMcp, URDIRA_VERSION, urdiraHelp } from "./index.js";

const endpoint = process.env["URDIRA_ENDPOINT"];
const argv = process.argv.slice(2);
const INTERNAL_DAEMON_CHILD = "URDIRA_INTERNAL_DAEMON_CHILD";

const startupMessages: Readonly<Record<DaemonStartupPhase, string>> = {
  locking: "acquiring the per-user daemon lock",
  catalog_verification: "verifying the catalog and persisted state",
  workspace_recovery: "recovering workspaces and durable cursors",
  provider_reconciliation: "reconciling source providers and watchers",
  ready: "daemon ready",
};

function writeStartupProgress(phase: DaemonStartupPhase): void {
  process.stderr.write(`[urdira] ${startupMessages[phase]}\n`);
}

function isDaemonStart(args: readonly string[]): boolean {
  return args[0] === "daemon" && args[1] === "start" && !args.includes("--dry-run");
}

function isV3Migration(args: readonly string[]): boolean {
  return args[0] === "migrate" && args.includes("--to-data-format") && args.includes("3") && args.includes("--reindex");
}

async function runV3Migration(args: readonly string[]): Promise<void> {
  const dataRoot = process.env["URDIRA_DATA_ROOT"] ?? join(homedir(), ".urdira");
  const preview = await migrateToV3({ data_root: dataRoot, confirm: args.includes("--confirm") });
  process.stdout.write(`${JSON.stringify(preview)}\n`);
  if (!args.includes("--confirm")) {
    process.stderr.write("Migration preview only. Repeat with --confirm to prepare a sibling v3 data root; the legacy root and CAS are preserved.\n");
    process.exitCode = 2;
  }
}

function isChildMessage(value: unknown): value is
  | { readonly type: "progress"; readonly phase: DaemonStartupPhase }
  | { readonly type: "result"; readonly result: CliResult }
  | { readonly type: "error"; readonly error: string } {
  if (value === null || typeof value !== "object" || !("type" in value)) return false;
  const message = value as { readonly type?: unknown; readonly phase?: unknown; readonly result?: unknown; readonly error?: unknown };
  if (message.type === "progress") return typeof message.phase === "string" && message.phase in startupMessages;
  if (message.type === "result") return message.result !== null && typeof message.result === "object";
  return message.type === "error" && typeof message.error === "string";
}

async function runDaemonChild(): Promise<void> {
  delete process.env[INTERNAL_DAEMON_CHILD];
  const send = (message: unknown): void => { if (process.connected) process.send?.(message); };
  try {
    const result = await runUrdira(["daemon", "start"], {
      ...(endpoint === undefined ? {} : { endpoint }),
      on_startup_progress: (phase) => send({ type: "progress", phase }),
    });
    send({ type: "result", result });
    process.disconnect?.();
    // A daemon this child started owns a listening local socket, which keeps
    // the event loop alive. If it merely attached to an existing daemon,
    // there is no owned handle and this child exits naturally after sending
    // the idempotent already-running result.
  } catch (error) {
    send({ type: "error", error: error instanceof Error ? error.stack ?? error.message : String(error) });
    process.disconnect?.();
    process.exitCode = 1;
  }
}

async function startDetachedDaemon(): Promise<CliResult> {
  const dataRoot = process.env["URDIRA_DATA_ROOT"] ?? join(homedir(), ".urdira");
  await mkdir(dataRoot, { recursive: true, mode: 0o700 });
  const logPath = join(dataRoot, "daemon.log");
  const log = await open(logPath, "a", 0o600);
  process.stderr.write(`[urdira] launching background daemon (log: ${logPath})\n`);
  const child = fork(fileURLToPath(import.meta.url), [], {
    detached: true,
    env: { ...process.env, [INTERNAL_DAEMON_CHILD]: "1" },
    execArgv: [],
    stdio: ["ignore", log.fd, log.fd, "ipc"],
  });
  await log.close();

  return await new Promise<CliResult>((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      reject(new Error(`Timed out while starting the Urdira daemon. Inspect ${logPath}.`));
    }, 300_000);
    timeout.unref?.();
    const finish = (operation: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (child.connected) child.disconnect();
      child.unref();
      operation();
    };
    child.on("message", (message) => {
      if (!isChildMessage(message)) return;
      if (message.type === "progress") { writeStartupProgress(message.phase); return; }
      if (message.type === "result") { finish(() => resolve(message.result)); return; }
      finish(() => reject(new Error(message.error)));
    });
    child.once("error", (error) => finish(() => reject(error)));
    child.once("exit", (code, signal) => {
      if (!settled) finish(() => reject(new Error(`Urdira daemon child exited before readiness (${code ?? "no-code"}/${signal ?? "no-signal"}). Inspect ${logPath}.`)));
    });
  });
}

if (process.env[INTERNAL_DAEMON_CHILD] === "1") {
  await runDaemonChild();
} else if (argv.length === 1 && (argv[0] === "--version" || argv[0] === "-v")) {
  process.stdout.write(`${URDIRA_VERSION}\n`);
} else if (argv.length === 0 || (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h"))) {
  process.stdout.write(urdiraHelp());
} else if (argv[0] === "mcp") {
  const handle = await runUrdiraMcp({ ...(endpoint === undefined ? {} : { endpoint }) });
  process.stdin.resume();
  await new Promise<void>((resolve) => process.stdin.once("end", resolve));
  await handle.close();
} else if (isDaemonStart(argv)) {
  parseCliArgs(argv);
  const result = await startDetachedDaemon();
  process.stdout.write(result.stdout);
  process.exitCode = result.exit_code;
} else if (isV3Migration(argv)) {
  await runV3Migration(argv);
} else {
  const result = await runUrdira(argv, {
    ...(endpoint === undefined ? {} : { endpoint }),
    on_startup_progress: writeStartupProgress,
  });
  process.stdout.write(result.stdout);
  process.exitCode = result.exit_code;
}
