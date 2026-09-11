import { defaultDaemonOptions } from "../../apps/urdira/dist/index.js";
import {
  DaemonRuntime,
  DaemonClient,
} from "../../packages/daemon/dist/index.js";
import { serveUrdiraStdio } from "../../packages/mcp/dist/index.js";
import { appendFileSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const root = process.env.URDIRA_MICRO_REPOSITORY;
if (!root) throw new Error("URDIRA_MICRO_REPOSITORY is required");
const dataRoot = process.env.URDIRA_DATA_ROOT;
const runtime = await DaemonRuntime.start({
  ...(await defaultDaemonOptions(dataRoot)),
  data_root: dataRoot,
  semantic_index: false,
  semantic_descriptor: undefined,
  reconciliation_sweep_interval_ms: 0,
});
const client = new DaemonClient(runtime.endpoint, {
  request_timeout_ms: 1800000,
});
const registration = await client.call("core:workspace_add", {
  args: [root],
  confirmed: true,
  selected_technology_ids: ["javascript", "typescript"],
  selected_plugin_ids: ["urdira:javascript_typescript"],
});
if (registration.outcome !== "success")
  throw new Error(
    `workspace registration failed: ${JSON.stringify(registration)}`,
  );
const workspaceId = registration.payload?.workspace_id;
const deadline = Date.now() + 1_800_000;
let status;
while (Date.now() < deadline) {
  status = await client.call("core:index_status", {
    api_version: 3,
    workspace_ids: typeof workspaceId === "string" ? [workspaceId] : [],
  });
  const entry = status.payload?.workspaces?.[0];
  if ([entry?.workspace_status, entry?.freshness_status].includes("failed"))
    throw new Error(`structural readiness failed: ${JSON.stringify(status)}`);
  if (
    entry?.structural_ready === true &&
    ["current", "equivalent"].includes(entry?.freshness_status)
  )
    break;
  await sleep(500);
}
if (!status?.payload?.workspaces?.[0]?.structural_ready)
  throw new Error("structural readiness timeout");
writeFileSync(
  `${dataRoot}/micro-bootstrap.json`,
  JSON.stringify(
    {
      registration: registration.payload,
      status: status.payload,
      query_scope: {
        scope_type: "single_workspace",
        workspace_id: workspaceId,
      },
    },
    null,
    2,
  ),
);
const telemetryPath = `${dataRoot}/micro-telemetry.jsonl`;
const instrumentedClient = {
  call: (call, payload, options = {}) =>
    client.call(call, payload, {
      ...options,
      on_progress: (progress) => {
        if (
          progress?.message?.startsWith("operation_metrics=") ||
          progress?.message?.startsWith("operation_page_metrics=")
        ) {
          appendFileSync(
            telemetryPath,
            `${JSON.stringify({ method: "notifications/progress", params: progress })}\n`,
          );
        }
        options.on_progress?.(progress);
      },
    }),
};
const handle = serveUrdiraStdio(
  { client: instrumentedClient },
  { instructions: "production", compact: false },
);
const close = async () => {
  try {
    await handle.close();
  } finally {
    await runtime.stop();
  }
};
process.once("SIGINT", () => void close());
process.once("SIGTERM", () => void close());
