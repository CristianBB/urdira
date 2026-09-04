//! High-level tsgo async-API client: spawns the binary, speaks the JSON-RPC
//! protocol from `crate::rpc` over its stdio, answers its virtual-FS
//! callbacks from a caller-supplied `crate::virtual_fs::VirtualFs`, and
//! exposes the typed subset of the API surface this crate's
//! `ResidualResolver` needs.
//!
//! Method names and parameter shapes are transcribed from the request call
//! sites in
//! `node_modules/.pnpm/typescript@7.0.2/node_modules/typescript/dist/api/async/api.js`
//! (see that file's `apiRequest("methodName", { ... })` calls) — not from
//! any published schema, since the wire protocol has none; see the
//! crate-level docs for the versioning risk this implies.

use std::collections::HashMap;
use std::io::BufReader;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;

use serde_json::{Value, json};

use crate::binary::TsgoBinary;
use crate::node::{NodeHandle, RemoteSourceFile};
use crate::proto::{
    DiagnosticResponse, InitializeResponse, SignatureResponse, SnapshotInfo, SymbolResponse,
    TypeResponse, UpdateSnapshotParams,
};
use crate::rpc::{RpcErrorPayload, read_message, write_request, write_response};
use crate::virtual_fs::VirtualFs;

/// The five FS callback names tsgo's `--callbacks=` flag accepts
/// (`dist/api/fs.js`'s `fsCallbackNames`). This crate always enables all
/// five: its `VirtualFs` is authoritative (see that module's docs), so
/// there is never a reason to leave one of them to tsgo's own (nonexistent,
/// in `--api` mode) real-filesystem fallback.
const FS_CALLBACK_NAMES: [&str; 5] = [
    "readFile",
    "fileExists",
    "directoryExists",
    "getAccessibleEntries",
    "realpath",
];

pub type RequestResult<T> = Result<T, ClientError>;

#[derive(Debug)]
pub enum ClientError {
    Io(std::io::Error),
    Rpc(RpcErrorPayload),
    /// The connection's reader thread exited (tsgo closed stdout, or the
    /// process died) before a response for this request arrived.
    ConnectionClosed,
    /// The server returned `null`/absent where this crate's API contract
    /// (mirroring the TS wrapper's own `throw` on an impossible-null
    /// response — e.g. `getAliasedSymbol`, which "always returns a symbol")
    /// says it should not.
    UnexpectedNull {
        method: &'static str,
    },
    Decode(crate::node::DecodeError),
}

impl std::fmt::Display for ClientError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ClientError::Io(e) => write!(f, "I/O error talking to tsgo: {e}"),
            ClientError::Rpc(e) => write!(f, "{e}"),
            ClientError::ConnectionClosed => {
                write!(f, "tsgo connection closed before a response arrived")
            }
            ClientError::UnexpectedNull { method } => {
                write!(f, "{method} unexpectedly returned null")
            }
            ClientError::Decode(e) => write!(f, "failed to decode tsgo response: {e}"),
        }
    }
}

impl std::error::Error for ClientError {}

impl From<std::io::Error> for ClientError {
    fn from(value: std::io::Error) -> Self {
        ClientError::Io(value)
    }
}

impl From<crate::node::DecodeError> for ClientError {
    fn from(value: crate::node::DecodeError) -> Self {
        ClientError::Decode(value)
    }
}

type PendingMap = Arc<Mutex<HashMap<u64, mpsc::Sender<Result<Value, RpcErrorPayload>>>>>;

/// `stdin` is shared between the requesting thread(s) and the reader thread
/// (which must answer FS callbacks on the same pipe), so writes from either
/// side serialize through one `Mutex`. It is `Option` rather than a bare
/// `ChildStdin` so `shutdown` can `take()` and drop it to close the
/// underlying file descriptor immediately — the real client's own `close()`
/// relies on exactly this to unblock the server's blocking stdin read (see
/// that method's doc comment) — regardless of how many `Arc` clones of this
/// `Mutex` still exist.
type SharedStdin = Arc<Mutex<Option<ChildStdin>>>;

/// A live tsgo child process and its JSON-RPC connection.
pub struct TsgoClient {
    child: Child,
    stdin: SharedStdin,
    next_id: AtomicU64,
    pending: PendingMap,
    reader_thread: Option<JoinHandle<()>>,
    initialized: Option<InitializeResponse>,
}

impl TsgoClient {
    /// Spawns `binary` as `tsc --api --async --cwd <root>
    /// --callbacks=<all five names>`, wires up a reader thread that
    /// correlates responses by id and answers FS callback requests from
    /// `fs`, and returns once the process has started (not once it has
    /// responded to anything — call `initialize()` next).
    pub fn spawn(binary: &TsgoBinary, root: &str, fs: Arc<dyn VirtualFs>) -> RequestResult<Self> {
        let mut child = Command::new(&binary.path)
            .arg("--api")
            .arg("--async")
            .arg("--cwd")
            .arg(root)
            .arg(format!("--callbacks={}", FS_CALLBACK_NAMES.join(",")))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()?;

        let stdin: SharedStdin = Arc::new(Mutex::new(Some(
            child.stdin.take().expect("stdin was piped"),
        )));
        let stdout = child.stdout.take().expect("stdout was piped");
        let pending: PendingMap = Arc::new(Mutex::new(HashMap::new()));

        let reader_thread = {
            let pending = Arc::clone(&pending);
            let stdin = Arc::clone(&stdin);
            std::thread::Builder::new()
                .name("urdira-tsgo-reader".to_string())
                .spawn(move || reader_loop(stdout, stdin, pending, fs))
                .expect("spawning the tsgo reader thread should not fail")
        };

        Ok(Self {
            child,
            stdin,
            next_id: AtomicU64::new(1),
            pending,
            reader_thread: Some(reader_thread),
            initialized: None,
        })
    }

    fn send(&self, method: &str, params: Value) -> RequestResult<Value> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = mpsc::channel();
        self.pending.lock().unwrap().insert(id, tx);
        {
            let mut guard = self.stdin.lock().unwrap();
            match guard.as_mut() {
                Some(stdin) => {
                    if let Err(e) = write_request(stdin, id, method, &params) {
                        self.pending.lock().unwrap().remove(&id);
                        return Err(ClientError::Io(e));
                    }
                }
                None => {
                    self.pending.lock().unwrap().remove(&id);
                    return Err(ClientError::ConnectionClosed);
                }
            }
        }
        match rx.recv() {
            Ok(Ok(value)) => Ok(value),
            Ok(Err(rpc_error)) => Err(ClientError::Rpc(rpc_error)),
            Err(_) => Err(ClientError::ConnectionClosed),
        }
    }

    /// `initialize` — must be called once before any other request; the
    /// real wrapper (`API.ensureInitialized`) calls it lazily on first use,
    /// but this crate makes the ordering explicit since it has no
    /// lazy-init wrapper of its own.
    pub fn initialize(&mut self) -> RequestResult<InitializeResponse> {
        let value = self.send("initialize", Value::Null)?;
        let response: InitializeResponse = serde_json::from_value(value).map_err(|e| {
            ClientError::Io(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                e.to_string(),
            ))
        })?;
        self.initialized = Some(response.clone());
        Ok(response)
    }

    /// The response `initialize()` returned, if it has been called yet.
    pub fn initialize_response(&self) -> Option<&InitializeResponse> {
        self.initialized.as_ref()
    }

    /// The OS process id of the spawned tsgo child, for out-of-band
    /// inspection (e.g. `tests/bench_tsgo.rs` samples RSS via `ps`).
    pub fn pid(&self) -> u32 {
        self.child.id()
    }

    pub fn update_snapshot(&self, params: &UpdateSnapshotParams) -> RequestResult<SnapshotInfo> {
        let value = self.send("updateSnapshot", serde_json::to_value(params).unwrap())?;
        serde_json::from_value(value).map_err(|e| {
            ClientError::Io(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                e.to_string(),
            ))
        })
    }

    pub fn release(&self, snapshot: u64) -> RequestResult<()> {
        self.send("release", json!({ "snapshot": snapshot }))?;
        Ok(())
    }

    /// `getSourceFile` — a binary (base64-in-JSON) response, decoded via
    /// `crate::node::RemoteSourceFile`. `None` if the file is not part of
    /// `project`'s program.
    pub fn get_source_file(
        &self,
        snapshot: u64,
        project: &str,
        file: &str,
    ) -> RequestResult<Option<RemoteSourceFile>> {
        let value = self.send(
            "getSourceFile",
            json!({ "snapshot": snapshot, "project": project, "file": file }),
        )?;
        if value.is_null() {
            return Ok(None);
        }
        let base64_data =
            value
                .get("data")
                .and_then(Value::as_str)
                .ok_or(ClientError::UnexpectedNull {
                    method: "getSourceFile",
                })?;
        let bytes = base64_decode(base64_data).map_err(|e| {
            ClientError::Io(std::io::Error::new(std::io::ErrorKind::InvalidData, e))
        })?;
        let source_file = RemoteSourceFile::decode(bytes, crate::node::PROTOCOL_VERSION)?;
        Ok(Some(source_file))
    }

    pub fn get_symbols_at_locations(
        &self,
        snapshot: u64,
        project: &str,
        locations: &[NodeHandle],
    ) -> RequestResult<Vec<Option<SymbolResponse>>> {
        let value = self.send(
            "getSymbolsAtLocations",
            json!({
                "snapshot": snapshot,
                "project": project,
                "locations": locations.iter().map(NodeHandle::to_wire).collect::<Vec<_>>(),
            }),
        )?;
        parse_optional_vec(value)
    }

    pub fn get_symbol_at_location(
        &self,
        snapshot: u64,
        project: &str,
        location: &NodeHandle,
    ) -> RequestResult<Option<SymbolResponse>> {
        let value = self.send(
            "getSymbolAtLocation",
            json!({ "snapshot": snapshot, "project": project, "location": location.to_wire() }),
        )?;
        parse_optional(value)
    }

    pub fn get_symbols_at_positions(
        &self,
        snapshot: u64,
        project: &str,
        file: &str,
        positions: &[i32],
    ) -> RequestResult<Vec<Option<SymbolResponse>>> {
        let value = self.send(
            "getSymbolsAtPositions",
            json!({ "snapshot": snapshot, "project": project, "file": file, "positions": positions }),
        )?;
        parse_optional_vec(value)
    }

    /// `getAliasedSymbol` — per `proto.d.ts`'s doc comment, "always returns
    /// a symbol" (an unresolved alias yields the checker's synthetic
    /// "unknown" symbol, not null), so an actually-null response is treated
    /// as a protocol-contract violation rather than a normal miss.
    pub fn get_aliased_symbol(
        &self,
        snapshot: u64,
        project: &str,
        symbol: u64,
    ) -> RequestResult<SymbolResponse> {
        let value = self.send(
            "getAliasedSymbol",
            json!({ "snapshot": snapshot, "project": project, "symbol": symbol }),
        )?;
        parse_optional(value)?.ok_or(ClientError::UnexpectedNull {
            method: "getAliasedSymbol",
        })
    }

    pub fn get_resolved_signature(
        &self,
        snapshot: u64,
        project: &str,
        location: &NodeHandle,
    ) -> RequestResult<Option<SignatureResponse>> {
        let value = self.send(
            "getResolvedSignature",
            json!({ "snapshot": snapshot, "project": project, "location": location.to_wire() }),
        )?;
        parse_optional(value)
    }

    pub fn get_type_at_locations(
        &self,
        snapshot: u64,
        project: &str,
        locations: &[NodeHandle],
    ) -> RequestResult<Vec<Option<TypeResponse>>> {
        let value = self.send(
            "getTypeAtLocations",
            json!({
                "snapshot": snapshot,
                "project": project,
                "locations": locations.iter().map(NodeHandle::to_wire).collect::<Vec<_>>(),
            }),
        )?;
        parse_optional_vec(value)
    }

    pub fn type_to_string(
        &self,
        snapshot: u64,
        project: &str,
        type_id: u64,
        location: Option<&NodeHandle>,
        flags: Option<u32>,
    ) -> RequestResult<String> {
        let value = self.send(
            "typeToString",
            json!({
                "snapshot": snapshot,
                "project": project,
                "type": type_id,
                "location": location.map(NodeHandle::to_wire),
                "flags": flags,
            }),
        )?;
        value
            .as_str()
            .map(str::to_string)
            .ok_or(ClientError::UnexpectedNull {
                method: "typeToString",
            })
    }

    /// `getExportsOfModule` -- the module symbol's own exported symbols
    /// (`dist/api/async/api.js`'s `Checker.getExportsOfModule`), used by
    /// `crate::semantic_extras` to reproduce `analyzer.ts`'s
    /// `checker.getExportsOfModule(moduleSymbol)` exported-declaration set
    /// (task P1-D "inferred types" half). `symbol` is a module symbol's own
    /// `id` (fetched via `get_symbol_at_location` on the source file's own
    /// node, index 1 -- see `crate::node::syntax_kind::SOURCE_FILE`). An
    /// absent/null response (a script with no module symbol) is an empty
    /// list, mirroring `analyzer.ts`'s own `try {...} catch { /* a script
    /// without a module symbol has no exported type facts */ }`.
    pub fn get_exports_of_module(
        &self,
        snapshot: u64,
        project: &str,
        symbol: u64,
    ) -> RequestResult<Vec<SymbolResponse>> {
        let value = self.send(
            "getExportsOfModule",
            json!({ "snapshot": snapshot, "project": project, "symbol": symbol }),
        )?;
        if value.is_null() {
            return Ok(Vec::new());
        }
        let items = value.as_array().ok_or_else(|| {
            ClientError::Io(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "expected an array",
            ))
        })?;
        items
            .iter()
            .map(|item| {
                serde_json::from_value(item.clone()).map_err(|e| {
                    ClientError::Io(std::io::Error::new(
                        std::io::ErrorKind::InvalidData,
                        e.to_string(),
                    ))
                })
            })
            .collect()
    }

    fn diagnostics_request(
        &self,
        method: &str,
        snapshot: u64,
        project: &str,
        file: Option<&str>,
    ) -> RequestResult<Vec<DiagnosticResponse>> {
        let mut params = json!({ "snapshot": snapshot, "project": project });
        if let Some(file) = file {
            params["file"] = json!(file);
        }
        let value = self.send(method, params)?;
        if value.is_null() {
            return Ok(Vec::new());
        }
        let items = value.as_array().ok_or_else(|| {
            ClientError::Io(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "expected an array",
            ))
        })?;
        items
            .iter()
            .map(|item| {
                serde_json::from_value(item.clone()).map_err(|e| {
                    ClientError::Io(std::io::Error::new(
                        std::io::ErrorKind::InvalidData,
                        e.to_string(),
                    ))
                })
            })
            .collect()
    }

    /// `getSyntacticDiagnostics` -- parse diagnostics for `file` (or every
    /// file in `project` when `file` is `None`, unused by this crate's own
    /// callers, which always scope to one owner file at a time exactly like
    /// `analyzer.ts`'s per-file `program.getSyntacticDiagnostics(target)`).
    pub fn get_syntactic_diagnostics(
        &self,
        snapshot: u64,
        project: &str,
        file: Option<&str>,
    ) -> RequestResult<Vec<DiagnosticResponse>> {
        self.diagnostics_request("getSyntacticDiagnostics", snapshot, project, file)
    }

    /// `getBindDiagnostics` -- binder diagnostics, the second of the three
    /// diagnostic sources `analyzer.ts` concatenates into `jsts:diagnostic`
    /// rows (`[...getSyntacticDiagnostics, ...getBindDiagnostics,
    /// ...getSemanticDiagnostics]`).
    pub fn get_bind_diagnostics(
        &self,
        snapshot: u64,
        project: &str,
        file: Option<&str>,
    ) -> RequestResult<Vec<DiagnosticResponse>> {
        self.diagnostics_request("getBindDiagnostics", snapshot, project, file)
    }

    /// `getSemanticDiagnostics` -- type-check diagnostics, the third of the
    /// three sources `analyzer.ts` concatenates (see `get_bind_diagnostics`'s
    /// doc comment).
    pub fn get_semantic_diagnostics(
        &self,
        snapshot: u64,
        project: &str,
        file: Option<&str>,
    ) -> RequestResult<Vec<DiagnosticResponse>> {
        self.diagnostics_request("getSemanticDiagnostics", snapshot, project, file)
    }

    /// Closes stdin (unblocking tsgo's read loop, per the real client's own
    /// `close()` comment — sending a signal would race the process being
    /// blocked on a stdin read) and waits for the process to exit. Any
    /// request still in flight when this is called resolves with
    /// `ClientError::ConnectionClosed` once the reader thread notices the
    /// connection ended.
    pub fn shutdown(mut self) -> std::io::Result<std::process::ExitStatus> {
        // `take()` drops the one live `ChildStdin` right here, closing the
        // pipe immediately regardless of how many `Arc` clones of the
        // `Mutex` the reader thread still holds — see `SharedStdin`'s doc
        // comment for why a bare `Arc<Mutex<ChildStdin>>` would not do this.
        let _ = self.stdin.lock().unwrap().take();
        let status = self.child.wait()?;
        if let Some(handle) = self.reader_thread.take() {
            let _ = handle.join();
        }
        Ok(status)
    }
}

fn parse_optional<T: serde::de::DeserializeOwned>(value: Value) -> RequestResult<Option<T>> {
    if value.is_null() {
        return Ok(None);
    }
    serde_json::from_value(value).map(Some).map_err(|e| {
        ClientError::Io(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            e.to_string(),
        ))
    })
}

fn parse_optional_vec<T: serde::de::DeserializeOwned>(
    value: Value,
) -> RequestResult<Vec<Option<T>>> {
    if value.is_null() {
        return Ok(Vec::new());
    }
    let items = value.as_array().ok_or_else(|| {
        ClientError::Io(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "expected an array",
        ))
    })?;
    items
        .iter()
        .map(|item| parse_optional(item.clone()))
        .collect()
}

fn base64_decode(input: &str) -> Result<Vec<u8>, String> {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD
        .decode(input)
        .map_err(|e| e.to_string())
}

fn reader_loop(
    stdout: std::process::ChildStdout,
    stdin: SharedStdin,
    pending: PendingMap,
    fs: Arc<dyn VirtualFs>,
) {
    let mut reader = BufReader::new(stdout);
    loop {
        let message = match read_message(&mut reader) {
            Ok(Some(message)) => message,
            Ok(None) => break,
            Err(_) => break,
        };
        match (&message.id, &message.method) {
            (Some(id), Some(method)) => {
                // A server-to-client request (an FS callback): dispatch and
                // reply on the same connection.
                let params = message.params.clone().unwrap_or(Value::Null);
                let result = dispatch_callback(fs.as_ref(), method, &params);
                let mut guard = stdin.lock().unwrap();
                if let Some(stdin) = guard.as_mut() {
                    let _ = write_response(stdin, id, &result);
                }
            }
            (Some(id), None) => {
                // A response to one of our own requests.
                let Some(numeric_id) = id.as_u64() else {
                    continue;
                };
                if let Some(sender) = pending.lock().unwrap().remove(&numeric_id) {
                    let outcome = match message.error {
                        Some(error) => Err(error),
                        None => Ok(message.result.unwrap_or(Value::Null)),
                    };
                    let _ = sender.send(outcome);
                }
            }
            (None, Some(_method)) => {
                // A notification; this crate has none to act on.
            }
            (None, None) => {}
        }
    }
    // The connection is gone: wake every still-pending request rather than
    // leaving its caller blocked on `rx.recv()` forever.
    let mut pending = pending.lock().unwrap();
    for (_, sender) in pending.drain() {
        let _ = sender.send(Err(RpcErrorPayload {
            code: -32000,
            message: "tsgo connection closed".to_string(),
            data: None,
        }));
    }
}

fn dispatch_callback(fs: &dyn VirtualFs, method: &str, params: &Value) -> Value {
    let path = params.as_str().unwrap_or("");
    match method {
        "readFile" => match fs.read_file(path) {
            Some(text) => json!({ "content": text }),
            None => json!({ "content": null }),
        },
        "fileExists" => json!(fs.file_exists(path)),
        "directoryExists" => json!(fs.directory_exists(path)),
        "getAccessibleEntries" => match fs.get_accessible_entries(path) {
            Some(entries) => serde_json::to_value(entries).unwrap_or(Value::Null),
            None => Value::Null,
        },
        "realpath" => match fs.realpath(path) {
            Some(resolved) => json!(resolved),
            None => Value::Null,
        },
        _ => Value::Null,
    }
}
