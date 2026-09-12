import { chmodSync, writeFileSync } from "node:fs";

const shellQuote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;

export function writeUrdiraIsolatedShim(path, { node, cli, dataRoot, worker, endpoint }) {
  const source = `#!/bin/sh\nset -eu\nCLI=${shellQuote(cli)}\nNODE=${shellQuote(node)}\nDATA_ROOT=${shellQuote(dataRoot)}\nWORKER=${shellQuote(worker)}\nENDPOINT=${shellQuote(endpoint)}\n[ -f "$CLI" ] || { echo "urdira isolated CLI is unavailable" >&2; exit 127; }\nif [ "\${1:-}" = "--version" ]; then\n  exec "$NODE" "$CLI" "$@"\nfi\n[ -S "$ENDPOINT" ] || { echo "urdira benchmark daemon endpoint is unavailable" >&2; exit 78; }\nexport URDIRA_DATA_ROOT="$DATA_ROOT"\nexport URDIRA_ENDPOINT="$ENDPOINT"\nexport URDIRA_INDEXING_CORE_WORKER_PATH="$WORKER"\nexec "$NODE" "$CLI" "$@"\n`;
  writeFileSync(path, source, { mode: 0o700 });
  chmodSync(path, 0o700);
  return source;
}
