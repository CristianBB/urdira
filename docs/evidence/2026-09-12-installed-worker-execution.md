# Installed indexing worker execution

Date: 2026-09-12. Scope: production archive permissions and failed-spawn safety.
Authority: [decision 10](../decisions/10-daemon-mcp-packaging.md).

## Reproduction

The extracted archive contained `native/urdira-indexing-worker` with mode 0644,
while its syntax worker was executable. The prior archive smoke only checked
file presence and the launcher version; it did not execute the indexing worker.
Starting the installed daemon against the retained Playwright workspace reached
provider reconciliation and then exited with SIGTERM. A temporary diagnostic
preload outside the repository traced `ChildProcess.kill` with an undefined PID
to `createIndexingCoreProcessTransport` after its spawn failed. The first probe's
explicit endpoint was also invalid for starting a new daemon; its separate
failed output remains retained and is not attributed to the archive defect.

The faulty archive is retained as `batch-faulty-release.tar.gz`, SHA-256
`aeca7da00d604f61822d0f7811816e13590aa80ffa8b8070ec0ffb9dcd158815`, under
`/Users/Cristian/BenchmarkResults/urdira-agent-iteration-20260912/`.
The probe JSON, daemon logs and diagnostic preload are retained in the same root.

## Repair and regressions

The deterministic archive writer now gives both indexing-worker platform names
mode 0755. The native archive smoke starts the extracted indexing worker with
closed stdin and checks its exit, in addition to the launcher version and exact
native-file closure. The worker's normal EOF path exits 0.

A failed spawn no longer signals an uninitialized child handle. The synchronous
factory failure installs a listener for Node's asynchronous spawn error, so the
error does not become an unhandled event after the caller receives the failure.
No indexing algorithm, public query schema, source scope or pagination changes.

The regressions first failed with EACCES and an unexpected `kill` invocation.
After the repair, both focused suites pass all nine tests. The complete gate,
new archive acceptance and exact retained MCP query are verified subsequently;
results must be read from the accompanying runtime-iteration evidence and logs.

A diagnostic-only chmod of the extracted faulty worker, leaving its bytes and
other files unchanged, allowed the daemon to reach readiness. That derivative
is not a qualified release archive. The immediate structural query correctly
reported analysis in progress while the installed configuration rebuilt its
frontier; the final exact-query probe must wait for current structural readiness.

## Installed structural query loader

The next untouched archive (`403adb093b7c989b41a41adf8383cf99228d4623d28e83e65c1e66b2321942da`)
started successfully and reached complete structural readiness. Its MCP query
then exposed a separate loader error: the engine derived an addon path under
`installed-verified/node_modules/release/native/`, which only makes sense in a
source checkout. The extracted tree and exact failed MCP response remain saved.

Application composition now supplies the already verified closure's addon path
through `configureNativeStructuralStoreAddonPath`. This preserves the engine's
dependency direction and takes precedence over development overrides. Loader
regressions cover selection, cache reuse/invalidation and restoration of the
development fallback. A composition regression verifies that the application's
selected addon is the one subsequently loaded by structural queries.

A fresh untouched archive then passed the original Playwright MCP request:
two declarations and two references, current freshness, complete index and page
coverage, no remaining page. `installed-addon-mcp-probe.json` retains the exact
request, initialization, structural readiness and response; the probe performs
no shell source retrieval. This is a functional reproduction, not an agent
adoption measurement. A final complete gate follows the successful probe.
