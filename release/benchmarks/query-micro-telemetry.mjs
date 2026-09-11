/** Extracts daemon query telemetry forwarded as MCP progress notifications. */
export function extractQueryTelemetry(notification) {
  if (notification?.method !== "notifications/progress") return undefined;
  const message = notification.params?.message;
  if (typeof message !== "string") return undefined;
  const match = /^(operation_metrics|operation_page_metrics)=(\[.*\])$/su.exec(message);
  if (match === null) return undefined;
  try {
    return { kind: match[1], value: JSON.parse(match[2]) };
  } catch {
    return undefined;
  }
}
