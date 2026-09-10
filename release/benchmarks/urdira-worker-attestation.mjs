export const WORKER_STARTUP_ATTESTATION_PREFIX = "[urdira-indexing-worker] v4 startup_attestation ";

/**
 * Parses one worker stderr line. Invalid-looking attestation lines return
 * null so callers can fail closed when a requested diagnostic cannot be
 * proven. Unrelated worker diagnostics are also ignored.
 */
export function parseWorkerStartupAttestation(line) {
  if (typeof line !== "string" || !line.startsWith(WORKER_STARTUP_ATTESTATION_PREFIX)) return null;
  let payload;
  try {
    payload = JSON.parse(line.slice(WORKER_STARTUP_ATTESTATION_PREFIX.length).trim());
  } catch {
    return null;
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return null;
  if (payload.schema_version !== 1 || !Number.isSafeInteger(payload.pid) || payload.pid <= 0) return null;
  if (typeof payload.semantic_perf_enabled !== "boolean" || typeof payload.debug_timing_enabled !== "boolean") return null;
  if (payload.current_exe !== null && typeof payload.current_exe !== "string") return null;
  return payload;
}

export function findWorkerStartupAttestation(text) {
  if (typeof text !== "string") return null;
  for (const line of text.split("\n")) {
    const parsed = parseWorkerStartupAttestation(line);
    if (parsed !== null) return parsed;
  }
  return null;
}
