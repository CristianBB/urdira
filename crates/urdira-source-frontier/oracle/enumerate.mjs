// TS oracle for the Rust `urdira-source-frontier` walker/hasher: enumerates a
// fixture tree with the real `DirectorySourceProvider` (built dist, same
// component TS production uses) and prints one JSON line per observed file
// with exactly the fields the Rust side must reproduce: normalized_uri,
// observed_content_hash, observed_metadata_digest, provider_version_token.
//
// Usage: node oracle/enumerate.mjs <root>
import { digestLogicalValue } from "../../../packages/canonical/dist/index.js";
import { DirectorySourceProvider } from "../../../packages/engine/dist/directory-provider.js";

const root = process.argv[2];
if (!root) {
  console.error("usage: node enumerate.mjs <root>");
  process.exit(1);
}

const workspaceId = "workspace:oracle";
const bindingId = "binding:oracle";

function request(call, payload) {
  const envelope = {
    protocol_version: "1",
    request_id: `request:${call}`,
    request_digest: "",
    call,
    workspace_id: workspaceId,
    source_provider_binding_id: bindingId,
    component_id: "core:directory_source_provider",
    component_version: "1",
    deadline_at: "2099-01-01T00:00:00.000Z",
    cancellation_id: "cancellation:oracle",
    resource_budget: JSON.stringify({
      max_duration_ms: 60_000,
      max_response_bytes: 100_000_000,
      max_observations: 1_000_000,
      max_watch_events: 1_000,
    }),
    payload,
  };
  return {
    ...envelope,
    request_digest: digestLogicalValue({
      protocol_version: envelope.protocol_version,
      call: envelope.call,
      workspace_id: envelope.workspace_id,
      source_provider_binding_id: envelope.source_provider_binding_id,
      component_id: envelope.component_id,
      component_version: envelope.component_version,
      resource_budget: envelope.resource_budget,
      payload: envelope.payload,
    }),
  };
}

const completeScope = [{
  scope_type: "workspace",
  source_provider_binding_id: bindingId,
  source_provider: "core:directory_source_provider",
  normalized_scope_key: "",
}];

const provider = new DirectorySourceProvider({
  root,
  workspace_id: workspaceId,
  source_provider_binding_id: bindingId,
});

const response = await provider.enumerate(request("enumerate", { coverage_scopes: completeScope }));
if (response.outcome !== "success") {
  console.error(JSON.stringify(response));
  process.exit(1);
}
const decoded = JSON.parse(response.payload.observation_batch);
const rows = decoded.observations
  .map((observation) => ({
    normalized_uri: observation.normalized_uri,
    observed_content_hash: observation.observed_content_hash,
    observed_metadata_digest: observation.observed_metadata_digest,
    provider_version_token: observation.provider_version_token,
  }))
  .sort((a, b) => (a.normalized_uri < b.normalized_uri ? -1 : a.normalized_uri > b.normalized_uri ? 1 : 0));
for (const row of rows) console.log(JSON.stringify(row));
