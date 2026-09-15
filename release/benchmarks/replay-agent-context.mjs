#!/usr/bin/env node
/** Offline-only replay. Raw transcripts and their failure outcomes are immutable. */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { URL } from "node:url";
import { analyzeExpandedTranscript } from "./expanded-agent-transcript-metrics.mjs";

const args = process.argv.slice(2);
const outputIndex = args.indexOf("--output");
if (outputIndex < 0 || !args[outputIndex + 1]) throw new Error("Usage: replay-agent-context.mjs --output NEW.json RAW_DIRECTORY...");
const output = resolve(args[outputIndex + 1]);
const roots = args.filter((_, index) => index !== outputIndex && index !== outputIndex + 1).map((path) => resolve(path));
if (roots.length === 0) throw new Error("At least one raw directory is required.");
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const corpus = JSON.parse(readFileSync(new URL("./expanded-typescript-agent-benchmark.json", import.meta.url), "utf8"));
const runs = [];
for (const root of roots) {
  for (const name of readdirSync(root).filter((name) => name.endsWith(".jsonl") && !/(^|[.-])hook-audit\.jsonl$/.test(name)).sort()) {
    const path = join(root, name);
    const raw = readFileSync(path);
    const events = raw.toString("utf8").split("\n").filter(Boolean).map(JSON.parse);
    const manifestPath = path.slice(0, -1);
    const manifestBytes = existsSync(manifestPath) ? readFileSync(manifestPath) : null;
    const manifest = manifestBytes === null ? {} : JSON.parse(manifestBytes);
    const hookAuditPath = typeof manifest.hook_audit_path === "string" ? manifest.hook_audit_path : null;
    const hookAuditBytes = hookAuditPath !== null && existsSync(hookAuditPath) ? readFileSync(hookAuditPath) : null;
    const hookAudit = hookAuditBytes === null ? undefined : hookAuditBytes.toString("utf8").split("\n").filter(Boolean).map(JSON.parse);
    const task = corpus.repositories.find((repo) => repo.id === manifest.repository_id)?.tasks.find((task) => task.id === manifest.task_id) ?? {};
    const metrics = analyzeExpandedTranscript(events, manifest.arm, task, { workspace_root: manifest.worktree, ...(hookAudit === undefined ? {} : { hook_audit: hookAudit }) });
    if (digest(readFileSync(path)) !== digest(raw)) throw new Error(`Raw transcript changed during replay: ${path}`);
    runs.push({ run_id: manifest.run_id, arm: manifest.arm, completed_successfully: manifest.completed_successfully ?? null, grader_exit_code: manifest.grader_exit_code ?? null, host_session_evidence: manifest.host_session_evidence ?? null, raw: { transcript: path, sha256: digest(raw), manifest: manifestPath, manifest_sha256: manifestBytes === null ? null : digest(manifestBytes), hook_audit: hookAuditPath, hook_audit_sha256: hookAuditBytes === null ? null : digest(hookAuditBytes) }, metrics });
  }
}
writeFileSync(output, `${JSON.stringify({ schema_version: 1, replay_only: true, runs }, null, 2)}\n`, { flag: "wx" });
process.stdout.write(`${JSON.stringify({ output, runs: runs.length })}\n`);
