#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { analyzePostMeasurement } from "./post-index-measurement.mjs";
import { analyzeExpandedTranscript } from "./expanded-agent-transcript-metrics.mjs";

const args = process.argv.slice(2);
const value = (name) => { const i = args.indexOf(name); return i < 0 ? null : args[i + 1]; };
const planPath = value("--plan"), eventsPath = value("--events"), hostPath = value("--host-metrics"), output = value("--output");
if (!planPath || !eventsPath || !output) throw new Error("Usage: render-post-index-measurement.mjs --plan plan.json --events events.jsonl|events.json --host-metrics host.json --output report-base");
const plan = JSON.parse(readFileSync(planPath, "utf8"));
const eventText = readFileSync(eventsPath, "utf8");
const events = eventText.trimStart().startsWith("[") ? JSON.parse(eventText) : eventText.split("\n").filter(Boolean).map((line) => JSON.parse(line));
const hostMetrics = hostPath ? JSON.parse(readFileSync(hostPath, "utf8")) : null;
const measurement = analyzePostMeasurement({ events, plan, hostMetrics });
const transcript_metrics = analyzeExpandedTranscript(events, plan.arm ?? "urdira-typescript", null);
const report = { report_version: 1, generated_at: new Date().toISOString(), plan, measurement, transcript_metrics, comparison: { competitors: "reused existing audits only", rerun: false } };
const rows = Object.entries(measurement.operations).map(([operation, metric]) => `| ${operation} | ${metric.calls} | ${metric.successes} | ${metric.failures} | ${metric.pages} | ${metric.latency_ms.average ?? "—"} | ${metric.latency_ms.p95 ?? "—"} | ${metric.completeness.join(", ") || "—"} | ${metric.cap_applied === null ? "—" : metric.cap_applied ? "yes" : "no"} | ${Object.values(metric.bytes).map((value) => value ?? "—").join(" / ")} |`).join("\n");
const componentBytes = transcript_metrics.mcp_component_bytes;
const markdown = `# Post-index measurement\n\nDirected repositories: ${plan.repositories.map((repo) => `${repo.id} (${repo.commit})`).join(", ") || "none"}. Structural readiness is the boundary; semantic index, materialization, and sidecar are disabled. This report analyzes supplied raw evidence and does not execute campaigns or competitors.\n\n## Readiness\n\n| Structural readiness ms | Semantic index | Semantic materialization | Semantic sidecar |\n|---:|---|---|---|\n| ${measurement.readiness?.structural_readiness_ms ?? "—"} | ${measurement.readiness?.semantic_index ?? "—"} | ${measurement.readiness?.semantic_materialization ?? "—"} | ${measurement.readiness?.semantic_sidecar ?? "—"} |\n\n## Operations\n\n| Operation | Calls | Successes | Failures | Pages | Avg latency ms | P95 latency ms | Completeness | Cap applied | Bytes snippets / hydration / evidence / registry |\n|---|---:|---:|---:|---:|---:|---:|---|---|---|\n${rows}\n\n## Transcript components\n\n| Tool envelope | Model-visible serialized | Source text | Records | Hydration | Evidence | Registry |\n|---:|---:|---:|---:|---:|---:|---:|\n| ${componentBytes.tool_envelope ?? "—"} | ${componentBytes.model_visible_serialized ?? "—"} | ${componentBytes.source_text ?? "—"} | ${componentBytes.records ?? "—"} | ${componentBytes.hydration ?? "—"} | ${componentBytes.evidence ?? "—"} | ${componentBytes.registry ?? "—"} |\n\n## Adoption and limitations\n\n- MCP before shell: ${measurement.adoption.mcp_before_shell ?? "—"}; shell after MCP: ${measurement.adoption.shell_after_mcp ?? "—"}; zero MCP: ${measurement.adoption.zero_mcp}.\n- Failures are retained as rows and are not converted to zero. Missing measurements remain null.\n- ${measurement.limitations.join("\\n- ")}\n`;
writeFileSync(`${output}.json`, `${JSON.stringify(report, null, 2)}\n`);
writeFileSync(`${output}.md`, markdown);
console.log(JSON.stringify({ json: `${output}.json`, markdown: `${output}.md`, executed: false }));
