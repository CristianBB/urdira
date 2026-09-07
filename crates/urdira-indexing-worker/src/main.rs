#![forbid(unsafe_code)]

// v4 cold-scan pipeline (task P2-2b, plan `resilient-knitting-twilight.md`
// §4/§6.1). All new code lives under `src/v4/`; this file is touched only
// for this declaration and the `IndexingCommand::WorkspaceScan` dispatch
// arm below, so a concurrent effort touching this file's existing v3 facts
// lane in a separate worktree can still merge cleanly.
mod v4;

use rusqlite::{OptionalExtension, Transaction, params};
use serde::{Serialize, Serializer, ser::SerializeSeq};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet, VecDeque};
use std::fmt::Write as _;
use std::io::{self, Read, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use urdira_indexing_core::{
    COLD_DIRECT_ANALYZE_SQL, CORE_PROTOCOL_VERSION, CancellationToken, CandidatePublicationSink,
    CanonicalPhysicalGroup, CoreError, GenerationDescriptor, GenerationRequest, IndexingCore,
    LanguageEngine, PhysicalGroup, PublicationSink, StructuralKernelResult, prepare_engine_group,
};
use urdira_jsts_indexing_engine::JavascriptTypescriptEngine;
#[cfg(test)]
use urdira_jsts_syntax_worker::RecordBody;
use urdira_jsts_syntax_worker::{
    AnalysisBudgets, ConfigAssetInput, ExportPolicy, ExportResolution, FactsCursor,
    FactsGroupEntry, HybridResolutionContext, OwnerSemantics, ProposedRecord, SiteKind,
    SourceInput, SyntaxFileResult, SyntaxWorkerState, WorkerMessage, WorkspaceResolver,
    analyze_owner_semantics_with_context, decode_config_assets, resolve_named_export,
};
use urdira_worker_protocol::{
    AuthoritativeChangeSet, FrameDecoder, FrameOptions, INDEXING_CORE_PROTOCOL_IDENTITY,
    IndexingCommand, IndexingEvent, decode_json, encode_message,
};

const RUST_SEMANTIC_PROTOCOL: &str = "urdira:jsts-rust-semantic.v1";
// The closure manifest is metadata-only but a full n8n workspace can contain
// fourteen thousand source owners. Keep one bounded frame large enough for
// that immutable manifest; owner observations remain capped at 16 MiB and are
// still exchanged in physical groups, so this does not reintroduce a
// corpus-sized structural payload through the application process.
const RUST_SEMANTIC_MAX_MESSAGE_BYTES: usize = 128 * 1024 * 1024;

// Every structural generation invalidates queued lexical maintenance for an
// older generation. `schedule_lexical_reconcile` snapshots this epoch when it
// is scheduled and re-checks it both before taking the writer lease (quiet
// period) and on every retry inside its bounded wait loop; a change means a
// newer structural generation has since been accepted, and the stale pass
// steps aside instead of contending for the lease against it. Lexical
// maintenance is chunked and yields its lease every few seconds, so unlike
// the old detached secondary-index rebuild (removed; see
// docs/evidence/2026-09-02, T2) it reliably completes rather than starving.
static SECONDARY_MAINTENANCE_EPOCH: AtomicU64 = AtomicU64::new(0);

// The five derived accelerator indexes that a cold-direct publication used to
// leave to a *detached* post-publication rebuild pass. That pass raced every
// subsequent structural generation for the workspace writer lease using a
// single-attempt `open` (never `open_with_lease_wait`) and ceded to
// scan-priority on every retry, so on a busy corpus it could requeue
// indefinitely and never complete -- "secondary indexes ready" would simply
// never print. These indexes are derived accelerators, not part of the v3
// byte contract, and none of them participate in the cold-direct INSERT's own
// conflict resolution (see the `cold_direct` comment above the
// `record_occurrences`/`identity_assignments`/`artifact_dependencies` DROP
// INDEX statements), so building them inline, in the same transaction, right
// after the promotion inserts and before commit, is safe and removes the
// starvation risk entirely. Kept as (name, DDL) pairs at module scope so
// `publish()`'s inline `cold_direct` block and the accelerator-completeness
// test below share one source of truth for the DDL text.
//
// The other five accelerators recreated at the cold commit are kept in their
// own two arrays right below, rather than folded into the one above, because
// they are built at two different points inside the same transaction:
// `COLD_DIRECT_DIGEST_ORDER_ACCEL_INDEX` right before the
// `visible_record_digest` scan that depends on it, and
// `COLD_DIRECT_A1_ACCEL_INDEXES` later, alongside the five above, because the
// very next incremental publish's `DIRECT_PUBLICATION_CLOSURES_SQL` needs
// `record_occurrences_workspace_owner_idx` immediately (see
// docs/evidence/2026-09-01-f5-e3-cierre-tanda.md, A1). All three arrays
// together are the complete set of ten derived accelerators a cold-direct
// commit must leave built; see
// `cold_direct_commit_builds_every_accelerator_index` below, which is the
// regression guard for that completeness.
const COLD_DIRECT_DIGEST_ORDER_ACCEL_INDEX: (&str, &str) = (
    "record_occurrences_digest_order_idx",
    "CREATE INDEX IF NOT EXISTS record_occurrences_digest_order_idx ON record_occurrences(workspace_id, record_id, valid_from_generation, valid_to_generation, record_digest)",
);

const COLD_DIRECT_A1_ACCEL_INDEXES: &[(&str, &str)] = &[
    (
        "record_occurrences_visible_idx",
        "CREATE INDEX IF NOT EXISTS record_occurrences_visible_idx ON record_occurrences(workspace_id, valid_from_generation, valid_to_generation)",
    ),
    (
        "identity_assignments_owner_key_idx",
        "CREATE INDEX IF NOT EXISTS identity_assignments_owner_key_idx ON identity_assignments(workspace_id, identity_type, identity_key, valid_from_generation, valid_to_generation, record_id)",
    ),
    (
        "record_occurrences_workspace_owner_idx",
        "CREATE INDEX IF NOT EXISTS record_occurrences_workspace_owner_idx ON record_occurrences(workspace_id, owner_artifact_id, valid_from_generation, valid_to_generation)",
    ),
    (
        "record_occurrences_workspace_owner_version_idx",
        "CREATE INDEX IF NOT EXISTS record_occurrences_workspace_owner_version_idx ON record_occurrences(workspace_id, owner_artifact_id, owner_artifact_version_id, valid_from_generation, valid_to_generation, record_id)",
    ),
];

const COLD_DIRECT_NET_ACCEL_INDEXES: &[(&str, &str)] = &[
    (
        "identity_assignments_lookup_idx",
        "CREATE INDEX IF NOT EXISTS identity_assignments_lookup_idx ON identity_assignments(workspace_id, identity_type, identity_id, valid_from_generation, valid_to_generation)",
    ),
    (
        "identity_assignments_key_idx",
        "CREATE INDEX IF NOT EXISTS identity_assignments_key_idx ON identity_assignments(workspace_id, identity_key_digest, valid_from_generation, identity_type, identity_key, record_id)",
    ),
    (
        "identity_assignments_record_idx",
        "CREATE INDEX IF NOT EXISTS identity_assignments_record_idx ON identity_assignments(workspace_id, record_id, valid_from_generation, valid_to_generation)",
    ),
    (
        "artifact_dependencies_reverse_idx",
        "CREATE INDEX IF NOT EXISTS artifact_dependencies_reverse_idx ON artifact_dependencies(workspace_id, dependency_artifact_id, dependency_artifact_version_id, valid_from_generation, dependency_entry_id)",
    ),
    (
        "artifact_dependencies_direct_idx",
        "CREATE INDEX IF NOT EXISTS artifact_dependencies_direct_idx ON artifact_dependencies(workspace_id, record_id, valid_from_generation, valid_to_generation, dependency_artifact_id, dependency_artifact_version_id, dependency_role)",
    ),
];

mod publication_v3_sql;

struct SemanticChecker {
    child: Child,
    stdin: ChildStdin,
    stdout: ChildStdout,
}

struct ArcValueSlice<'a>(&'a [Arc<Value>]);

impl Serialize for ArcValueSlice<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut sequence = serializer.serialize_seq(Some(self.0.len()))?;
        for value in self.0 {
            sequence.serialize_element(value.as_ref())?;
        }
        sequence.end()
    }
}

/// One checker process is retained by the workspace composition worker across
/// generations. Its TypeScript snapshot/session is incremental state, not a
/// second writer: Rust still owns every structural receipt and SQLite mutation.
struct ReusableSemanticChecker {
    descriptor: urdira_worker_protocol::SemanticEngineDescriptor,
    checker: SemanticChecker,
}

/// Detached maintenance must not open a second SQLite connection while the
/// just-published operation still owns its connection.  Carry the immutable
/// maintenance envelope out of `FinalizeGeneration`, drop the active
/// operation first, and only then let the scheduler acquire the workspace
/// writer lease for lexical work.
struct LexicalMaintenance {
    database_path: String,
    request: GenerationRequest,
    cas_root: String,
    generation: i64,
    max_document_bytes: usize,
}

fn post_publication_deadline_ms() -> u64 {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(u64::MAX, |value| {
            value.as_millis().min(u128::from(u64::MAX)) as u64
        });
    now.saturating_add(10 * 60 * 1_000)
}

enum PostPublicationMaintenance {
    Lexical(LexicalMaintenance),
    WalCheckpoint {
        database_path: String,
        request: GenerationRequest,
    },
}

/// Schedule lexical maintenance after structural publication has become
/// visible. Structural readiness must not wait for FTS materialization; the
/// bounded retry window only covers the short metadata acknowledgement writer
/// interval and reports a terminal failure instead of spinning forever.
fn schedule_lexical_reconcile(
    database_path: String,
    request: GenerationRequest,
    cas_root: String,
    generation: i64,
    max_document_bytes: usize,
) {
    let scheduled_epoch = SECONDARY_MAINTENANCE_EPOCH.load(Ordering::Acquire);
    std::thread::spawn(move || {
        // Structural edits have priority over lexical maintenance, and every
        // generation -- including the cold one -- gets a bounded quiet
        // period before this pass even tries to take the writer lease. A
        // cold publication used to skip this grace period entirely, so a
        // cold reconcile of a large corpus (n8n-scale: 14k+ documents) could
        // start racing the very first foreground mutation (the harness's or
        // an editor's first save) for the lease before that edit ever got a
        // chance to run (docs/evidence/2026-09-01-f1-resultado.md). The cold
        // case uses a longer quiet period than the shorter edit-to-edit
        // interval, since a cold generation is reliably followed by more
        // foreground activity than a routine incremental edit is. If another
        // generation arrives during the quiet period, this pass is
        // superseded; the newer pass sees the latest visible source frontier
        // and will reconcile it instead.
        const COLD_LEXICAL_QUIET_PERIOD_MS: u64 = 15_000;
        const EDIT_LEXICAL_QUIET_PERIOD_MS: u64 = 5_000;
        let quiet_period_ms = if request.base_generation > 0 {
            EDIT_LEXICAL_QUIET_PERIOD_MS
        } else {
            COLD_LEXICAL_QUIET_PERIOD_MS
        };
        std::thread::sleep(Duration::from_millis(quiet_period_ms));
        if SECONDARY_MAINTENANCE_EPOCH.load(Ordering::Acquire) != scheduled_epoch {
            if std::env::var_os("URDIRA_DEBUG_TIMING").is_some() {
                eprintln!(
                    "[urdira-indexing-worker] lexical maintenance pre-empted during quiet period"
                );
            }
            return;
        }
        // Lexical maintenance is deliberately detached from structural
        // readiness, so an edit may start the next Rust generation while this
        // pass is waiting for its writer lease.  A short fixed retry budget
        // used to turn that normal race into a permanent lexical omission
        // (the first 20 attempts covered only a few seconds, while a cold
        // generation can legitimately run for minutes).  Keep the wait
        // bounded, but let it cover the complete publication window.
        let retry_deadline = Instant::now() + Duration::from_secs(10 * 60);
        let mut attempt = 0_u32;
        loop {
            if SECONDARY_MAINTENANCE_EPOCH.load(Ordering::Acquire) != scheduled_epoch {
                if std::env::var_os("URDIRA_DEBUG_TIMING").is_some() {
                    eprintln!(
                        "[urdira-indexing-worker] lexical maintenance pre-empted by structural generation"
                    );
                }
                return;
            }
            // Detached lexical maintenance is exactly the caller
            // `open_with_lease_wait` was built for: the Node structural
            // commit poller re-opens the workspace every time it wakes,
            // while `reconcile_lexical` yields the mutation lease every few
            // seconds instead of holding it for the pass's whole duration.
            // A single-attempt `open` lost that race systematically --
            // measured at 56 retries / 80.5s of this loop's own 250-2000ms
            // backoff before it happened to land inside a free window
            // (docs/evidence/2026-09-01-f5-e3-cierre-tanda.md, B1). Waiting
            // out the lease with the existing bounded 30s budget here
            // resolves almost every such race in one call; `retry_deadline`
            // above still bounds the outer loop as a 10-minute safety net
            // for the rare case that budget is exhausted too (e.g. a
            // structural generation that legitimately runs for minutes).
            match IndexingCore::open_with_lease_wait(&database_path, &request).and_then(|core| {
                let mut core = core;
                let result = core.reconcile_lexical(
                    &request.workspace_id,
                    &cas_root,
                    generation,
                    max_document_bytes,
                )?;
                let checkpoint = core.checkpoint_wal()?;
                Ok((result, checkpoint))
            }) {
                Ok(((closed, inserted, oversized), (busy, frames, checkpointed))) => {
                    eprintln!(
                        "[urdira-indexing-worker] lexical reconcile complete generation={generation} closed={closed} inserted={inserted} oversized={oversized} wal_busy={busy} wal_frames={frames} wal_checkpointed={checkpointed}"
                    );
                    // Derived accelerator indexes used to be rebuilt here, by
                    // a detached pass scheduled after this lexical reconcile
                    // completed. That pass raced every subsequent structural
                    // generation for the writer lease with a single-attempt
                    // `open` and ceded to scan-priority on every retry, so on
                    // a busy corpus it could requeue indefinitely and never
                    // complete. All ten accelerator indexes are now built
                    // inline, inside the cold-direct publish transaction
                    // itself (see `COLD_DIRECT_NET_ACCEL_INDEXES` and the
                    // `cold_direct` block in `publish()`), so there is
                    // nothing left for this pass to hand off.
                    return;
                }
                Err(error) if Instant::now() < retry_deadline => {
                    let delay_ms = (250_u64 + u64::from(attempt).saturating_mul(50)).min(2_000);
                    std::thread::sleep(Duration::from_millis(delay_ms));
                    attempt = attempt.saturating_add(1);
                    if std::env::var_os("URDIRA_DEBUG_TIMING").is_some() {
                        eprintln!(
                            "[urdira-indexing-worker] lexical reconcile retry attempt={} error={error}",
                            attempt
                        );
                    }
                }
                Err(error) => {
                    eprintln!(
                        "[urdira-indexing-worker] lexical reconcile failed after bounded retries: {error}"
                    );
                    break;
                }
            }
        }
    });
}

/// Checkpoints a generation that has no lexical phase.  Structural readiness
/// is already visible when this detached maintenance pass starts; a pinned
/// reader may defer the passive checkpoint without affecting publication.
fn schedule_wal_checkpoint(database_path: String, request: GenerationRequest) {
    std::thread::spawn(move || {
        match IndexingCore::open(&database_path, &request).and_then(|core| core.checkpoint_wal()) {
            Ok((busy, frames, checkpointed)) => eprintln!(
                "[urdira-indexing-worker] wal checkpoint complete busy={busy} frames={frames} checkpointed={checkpointed}"
            ),
            Err(error) => eprintln!("[urdira-indexing-worker] wal checkpoint deferred: {error}"),
        }
    });
}

#[derive(Debug, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct SemanticBridgeOwner {
    owner_artifact_id: String,
    owner_artifact_version_id: String,
    owner_path: String,
    batches: Vec<SemanticBridgeBatch>,
    #[serde(default)]
    next_cursor: Option<u64>,
    #[serde(default)]
    diagnostic_proposal_keys: Vec<String>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct SemanticBridgeBatch {
    sequence: u64,
    final_batch: bool,
    canonical_records: Vec<String>,
    canonical_dependencies: Vec<String>,
    byte_length: usize,
    owner_digest: String,
    fact_delta_id: Option<String>,
    delta_digest: Option<String>,
    #[serde(default)]
    diagnostic_codes: Vec<String>,
}

impl SemanticChecker {
    fn spawn(
        descriptor: &urdira_worker_protocol::SemanticEngineDescriptor,
    ) -> Result<Self, CoreError> {
        if descriptor.node_executable.is_empty()
            || descriptor.worker_entrypoint.is_empty()
            || !std::path::Path::new(&descriptor.node_executable).is_absolute()
            || !std::path::Path::new(&descriptor.worker_entrypoint).is_absolute()
            || descriptor.build_identity.is_empty()
        {
            return Err(CoreError(
                "JS/TS semantic checker executable descriptor is invalid".into(),
            ));
        }
        let mut child = Command::new(&descriptor.node_executable)
            .arg(&descriptor.worker_entrypoint)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            // Keep the private checker silent in normal operation. Expose its
            // bounded group timings only under the existing debug switch so
            // the Rust-owned generation can be profiled without routing rows
            // or callbacks through the application process.
            .stderr(
                if std::env::var("URDIRA_DEBUG_TIMING").as_deref() == Ok("1") {
                    Stdio::inherit()
                } else {
                    Stdio::null()
                },
            )
            .spawn()
            .map_err(|error| CoreError(format!("JS/TS semantic checker spawn failed: {error}")))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| CoreError("JS/TS semantic checker stdin is unavailable".into()))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| CoreError("JS/TS semantic checker stdout is unavailable".into()))?;
        let mut checker = Self {
            child,
            stdin,
            stdout,
        };
        let response = checker.call(serde_json::json!({
            "protocol_version": RUST_SEMANTIC_PROTOCOL,
            "kind": "handshake",
            "request_id": "handshake:1",
            "build_identity": descriptor.build_identity,
            "worker_descriptor": descriptor.worker_descriptor,
            "structural_kernel_addon_path": descriptor.structural_kernel_addon_path,
        }))?;
        if response.get("kind").and_then(serde_json::Value::as_str) != Some("handshake_ack") {
            return Err(CoreError(
                "JS/TS semantic checker handshake was rejected".into(),
            ));
        }
        Ok(checker)
    }

    fn call_serialized<T: Serialize>(
        &mut self,
        expected_request_id: &str,
        message: &T,
    ) -> Result<serde_json::Value, CoreError> {
        let payload = serde_json::to_vec(message).map_err(|error| {
            CoreError(format!("semantic checker request encode failed: {error}"))
        })?;
        if payload.is_empty() || payload.len() > RUST_SEMANTIC_MAX_MESSAGE_BYTES {
            return Err(CoreError(
                "semantic checker request exceeds the message budget".into(),
            ));
        }
        let length = u32::try_from(payload.len()).map_err(|_| {
            CoreError("semantic checker request length exceeds protocol range".into())
        })?;
        self.stdin
            .write_all(&length.to_be_bytes())
            .and_then(|_| self.stdin.write_all(&payload))
            .and_then(|_| self.stdin.flush())
            .map_err(|error| {
                CoreError(format!("semantic checker request write failed: {error}"))
            })?;
        let mut header = [0_u8; 4];
        self.stdout.read_exact(&mut header).map_err(|error| {
            CoreError(format!("semantic checker response header failed: {error}"))
        })?;
        let response_len = usize::try_from(u32::from_be_bytes(header))
            .map_err(|_| CoreError("semantic checker response length is invalid".into()))?;
        if response_len == 0 || response_len > RUST_SEMANTIC_MAX_MESSAGE_BYTES {
            return Err(CoreError(
                "semantic checker response exceeds the message budget".into(),
            ));
        }
        let mut response = vec![0_u8; response_len];
        self.stdout.read_exact(&mut response).map_err(|error| {
            CoreError(format!("semantic checker response read failed: {error}"))
        })?;
        let value: serde_json::Value = serde_json::from_slice(&response).map_err(|error| {
            CoreError(format!("semantic checker response decode failed: {error}"))
        })?;
        if value.get("request_id").and_then(Value::as_str) != Some(expected_request_id) {
            return Err(CoreError(
                "semantic checker response request id does not match".into(),
            ));
        }
        if value.get("kind").and_then(serde_json::Value::as_str) == Some("error") {
            return Err(CoreError(
                value
                    .get("error")
                    .and_then(|error| error.get("message"))
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("semantic checker rejected request")
                    .into(),
            ));
        }
        Ok(value)
    }

    fn call(&mut self, message: serde_json::Value) -> Result<serde_json::Value, CoreError> {
        let expected_request_id = message
            .get("request_id")
            .and_then(Value::as_str)
            .ok_or_else(|| CoreError("semantic checker request id is missing".into()))?
            .to_owned();
        self.call_serialized(&expected_request_id, &message)
    }

    fn invoke(&mut self, request: serde_json::Value) -> Result<serde_json::Value, CoreError> {
        self.call(serde_json::json!({
            "protocol_version": RUST_SEMANTIC_PROTOCOL,
            "kind": "invoke",
            "request_id": "invoke:rust",
            "request": request,
        }))
    }

    fn invoke_ref(&mut self, request: &Value) -> Result<serde_json::Value, CoreError> {
        #[derive(Serialize)]
        struct InvokeMessage<'a> {
            protocol_version: &'static str,
            kind: &'static str,
            request_id: &'static str,
            request: &'a Value,
        }
        // Serialize the immutable closure envelope by reference. Extra
        // checker lanes all receive the same metadata-only request; cloning
        // the complete n8n manifest once per lane needlessly multiplied the
        // cold working set before any semantic group was analyzed.
        self.call_serialized(
            "invoke:rust",
            &InvokeMessage {
                protocol_version: RUST_SEMANTIC_PROTOCOL,
                kind: "invoke",
                request_id: "invoke:rust",
                request,
            },
        )
    }

    fn analyze_group(
        &mut self,
        requests: &[Arc<Value>],
    ) -> Result<Vec<SemanticBridgeOwner>, CoreError> {
        #[derive(Serialize)]
        struct SemanticGroupMessage<'a> {
            protocol_version: &'static str,
            kind: &'static str,
            request_id: &'static str,
            requests: ArcValueSlice<'a>,
        }
        // Serialize the borrowed request slice directly. Constructing an
        // intermediate `Value` array here duplicated every owner envelope
        // before framing, which was visible on the 32-owner hot path.
        let response = self.call_serialized(
            "group:rust",
            &SemanticGroupMessage {
                protocol_version: RUST_SEMANTIC_PROTOCOL,
                kind: "analyze_group",
                request_id: "group:rust",
                requests: ArcValueSlice(requests),
            },
        )?;
        // Move the owners array out of the decoded response instead of
        // cloning the whole group before deserialization. The checker response
        // is single-use and can be discarded once its owners are consumed.
        let owners = match response {
            serde_json::Value::Object(mut object) => object.remove("owners").unwrap_or_default(),
            _ => serde_json::Value::Null,
        };
        serde_json::from_value(owners)
            .map_err(|error| CoreError(format!("semantic checker group decode failed: {error}")))
    }

    fn shutdown(&mut self) {
        let _ = self.call(serde_json::json!({
            "protocol_version": RUST_SEMANTIC_PROTOCOL,
            "kind": "shutdown",
            "request_id": "shutdown:rust",
        }));
    }
}

fn analyze_semantic_group(
    checker: &mut SemanticChecker,
    requests: &[Arc<Value>],
) -> Result<Vec<SemanticBridgeOwner>, CoreError> {
    // Borrow the request vector for the normal call. The JSON encoder creates
    // the one wire representation it needs; retaining a deep clone here was
    // only required by the old retry implementation and doubled peak group
    // memory before the request even crossed the checker boundary.
    match checker.analyze_group(requests) {
        Ok(owners) => Ok(owners),
        Err(error)
            if requests.len() > 1
                && error.0.to_ascii_lowercase().contains("semantic bridge")
                && error.0.to_ascii_lowercase().contains("exceeds") =>
        {
            let split = requests.len().div_ceil(2);
            let left = analyze_semantic_group(checker, &requests[..split])?;
            let right = analyze_semantic_group(checker, &requests[split..])?;
            Ok(left.into_iter().chain(right).collect())
        }
        Err(error) => Err(error),
    }
}

fn request_with_semantic_cursor(request: &Value, cursor: u64) -> Result<Value, CoreError> {
    let mut envelope = request
        .as_object()
        .cloned()
        .ok_or_else(|| CoreError("semantic request envelope is invalid".into()))?;
    let mut payload = envelope
        .get("payload")
        .and_then(Value::as_object)
        .cloned()
        .ok_or_else(|| CoreError("semantic request payload is invalid".into()))?;
    payload.insert("rust_semantic_cursor".into(), Value::from(cursor));
    envelope.insert("payload".into(), Value::Object(payload));
    Ok(Value::Object(envelope))
}

fn analyze_semantic_pages(
    checker: &mut SemanticChecker,
    requests: &[Arc<Value>],
) -> Result<Vec<SemanticBridgeOwner>, CoreError> {
    let initial = analyze_semantic_group(checker, requests)?;
    if initial.len() != requests.len() {
        return Err(CoreError(
            "semantic checker returned an incomplete owner group".into(),
        ));
    }
    let mut complete = Vec::with_capacity(initial.len());
    for (index, mut owner) in initial.into_iter().enumerate() {
        while let Some(cursor) = owner.next_cursor.take() {
            let request = Arc::new(request_with_semantic_cursor(
                requests[index].as_ref(),
                cursor,
            )?);
            let mut page = analyze_semantic_group(checker, std::slice::from_ref(&request))?;
            if page.len() != 1 {
                return Err(CoreError(
                    "semantic checker returned an invalid continuation page".into(),
                ));
            }
            let continuation = page.remove(0);
            if continuation.owner_artifact_id != owner.owner_artifact_id
                || continuation.owner_artifact_version_id != owner.owner_artifact_version_id
            {
                return Err(CoreError(
                    "semantic checker continuation owner does not match".into(),
                ));
            }
            owner.batches.extend(continuation.batches);
            owner.next_cursor = continuation.next_cursor;
        }
        complete.push(owner);
    }
    Ok(complete)
}

fn semantic_parallelism(owner_count: usize) -> usize {
    const MAX_CHECKERS: usize = 8;
    // The n8n cold gate has 1,000--1,400 affected owners.  Keeping the
    // previous 1,024 threshold left the 1,000-owner run on the serial lane,
    // even though the bounded four-lane replay is measurably faster.  Lower
    // the automatic cutoff only far enough to cover that cold shape; small
    // incremental closures (usually one or a few owners) remain serial and
    // do not pay for extra verified checker processes.
    const DEFAULT_PARALLELISM_THRESHOLD: usize = 768;
    let configured = std::env::var("URDIRA_RUST_SEMANTIC_PARALLELISM")
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .filter(|value| (1..=MAX_CHECKERS).contains(value));
    configured.unwrap_or(if owner_count >= DEFAULT_PARALLELISM_THRESHOLD {
        // Six lanes reduce the measured 1,000-owner n8n semantic span by
        // roughly 1.5 s versus the four-lane default while remaining below
        // the qualifying 8 GiB process-tree ceiling. The RSS trade-off is
        // intentional: this gate is time-bound, and the product accepts a
        // higher RSS sample when the readiness deadline is met.
        6
    } else {
        1
    })
}

fn bounded_semantic_observations(
    owner: SemanticBridgeOwner,
) -> Vec<urdira_indexing_core::CanonicalOwnerObservation> {
    const MAX_ROWS: usize = urdira_indexing_core::MAX_GROUP_ROWS;
    const MAX_BYTES: usize = urdira_indexing_core::MAX_GROUP_BYTES;
    let mut output = Vec::new();
    let mut sequence = 0_u64;
    for batch in owner.batches {
        let split_required = batch.canonical_records.len() + batch.canonical_dependencies.len()
            > MAX_ROWS
            || batch
                .canonical_records
                .iter()
                .chain(batch.canonical_dependencies.iter())
                .map(|value| value.len())
                .sum::<usize>()
                > MAX_BYTES;
        if !split_required {
            output.push(urdira_indexing_core::CanonicalOwnerObservation {
                owner_artifact_id: owner.owner_artifact_id.clone(),
                owner_artifact_version_id: owner.owner_artifact_version_id.clone(),
                owner_path: owner.owner_path.clone(),
                lane: "semantic".into(),
                sequence,
                final_batch: batch.final_batch,
                canonical_records: batch.canonical_records,
                canonical_dependencies: batch.canonical_dependencies,
                byte_length: batch.byte_length,
                owner_digest: batch.owner_digest,
                fact_delta_id: batch.fact_delta_id.filter(|value| !value.is_empty()),
                delta_digest: batch.delta_digest.filter(|value| !value.is_empty()),
                diagnostic_codes: batch.diagnostic_codes,
            });
            sequence += 1;
            continue;
        }
        let mut records = Vec::<String>::new();
        let mut dependencies = Vec::<String>::new();
        let mut bytes = 0_usize;
        let mut part = 0_u64;
        let mut flush = |final_batch: bool,
                         records: &mut Vec<String>,
                         dependencies: &mut Vec<String>,
                         bytes: &mut usize,
                         part: u64,
                         sequence: &mut u64| {
            if records.is_empty() && dependencies.is_empty() {
                return;
            }
            output.push(urdira_indexing_core::CanonicalOwnerObservation {
                owner_artifact_id: owner.owner_artifact_id.clone(),
                owner_artifact_version_id: owner.owner_artifact_version_id.clone(),
                owner_path: owner.owner_path.clone(),
                lane: "semantic".into(),
                sequence: *sequence,
                final_batch,
                canonical_records: std::mem::take(records),
                canonical_dependencies: std::mem::take(dependencies),
                byte_length: 0,
                owner_digest: String::new(),
                fact_delta_id: batch
                    .fact_delta_id
                    .as_ref()
                    .map(|id| format!("{id}:{part}")),
                delta_digest: batch.delta_digest.clone(),
                diagnostic_codes: batch.diagnostic_codes.clone(),
            });
            *bytes = 0;
            *sequence += 1;
        };
        let record_count = batch.canonical_records.len();
        for (index, canonical) in batch
            .canonical_records
            .into_iter()
            .chain(batch.canonical_dependencies)
            .enumerate()
        {
            let is_record = index < record_count;
            let canonical_bytes = canonical.len();
            if (!records.is_empty() || !dependencies.is_empty())
                && (records.len() + dependencies.len() >= MAX_ROWS
                    || bytes.saturating_add(canonical_bytes) > MAX_BYTES)
            {
                flush(
                    false,
                    &mut records,
                    &mut dependencies,
                    &mut bytes,
                    part,
                    &mut sequence,
                );
                part += 1;
            }
            if is_record {
                records.push(canonical);
            } else {
                dependencies.push(canonical);
            }
            bytes = bytes.saturating_add(canonical_bytes);
        }
        flush(
            batch.final_batch,
            &mut records,
            &mut dependencies,
            &mut bytes,
            part,
            &mut sequence,
        );
    }
    output
}

// --- F5 hybrid lane (E1b): oxc_semantic reference resolution merged into
// the checker-produced semantic observations. See
// docs/evidence/2026-09-01-f5-hybrid-design.md (stage E1) and
// crates/urdira-jsts-syntax-worker/src/semantic_sites.rs (stage E1a) for the
// contract this plumbing consumes. The hybrid lane is the PRODUCTION
// DEFAULT since 2026-09-01 (owner decision, docs/evidence/2026-09-01-f5-e3-cierre-tanda.md):
// strictly better precision for a measured ~4-7% cold cost. Set
// `URDIRA_JSTS_HYBRID=0` to fall back to the checker-only lane.

/// Gate for every hybrid-lane behavior. ON by default; `0` opts out.
fn hybrid_semantics_enabled() -> bool {
    hybrid_semantics_enabled_from(std::env::var("URDIRA_JSTS_HYBRID").ok().as_deref())
}

/// Pure parsing rule behind `hybrid_semantics_enabled`, split out so it can
/// be unit-tested without mutating the real process environment (tests run
/// concurrently in the same process; racing writes to a shared env var would
/// make any such test flaky).
fn hybrid_semantics_enabled_from(value: Option<&str>) -> bool {
    value != Some("0")
}

// --- P0-S2 prototype: the "typeflow" resolver (urdira v4 plan; see
// docs/evidence/2026-09-02-v4-p0-s2-typeflow-prototype.md). Gated behind
// `URDIRA_JSTS_TYPEFLOW=1`, default OFF, independent of `URDIRA_JSTS_HYBRID`
// but meaningless without it (typeflow only ever widens E1-E3's own
// `pending_sites`, so it is a no-op whenever the hybrid lane itself is off).

/// Gate for the typeflow resolver. Exact value `"1"` only -- matches every
/// other flag in this file's convention (`hybrid_semantics_enabled_from`'s
/// doc comment).
fn typeflow_enabled() -> bool {
    std::env::var("URDIRA_JSTS_TYPEFLOW").ok().as_deref() == Some("1")
}

/// `URDIRA_JSTS_TYPEFLOW_ORACLE=1`: run typeflow's resolution WITHOUT
/// removing the site from `pending_sites`, so the checker still
/// independently resolves it and this generation's per-owner merge can
/// compare the two answers (see `census_typeflow_owner`). Meaningless
/// (never read) when `typeflow_enabled()` is false.
fn typeflow_oracle_enabled() -> bool {
    std::env::var("URDIRA_JSTS_TYPEFLOW_ORACLE").ok().as_deref() == Some("1")
}

/// Destination file for the oracle census JSON (`URDIRA_JSTS_TYPEFLOW_ORACLE_OUT`).
/// `None` (oracle mode still runs, recording hits, but the census is never
/// written) when unset -- never a silent requirement.
fn typeflow_oracle_output_path() -> Option<PathBuf> {
    std::env::var_os("URDIRA_JSTS_TYPEFLOW_ORACLE_OUT").map(PathBuf::from)
}

/// Build the corpus-wide class/interface member index (P0-S2 prototype)
/// from every CURRENT project file's source text -- not just this
/// generation's `affected_paths`, since a member lookup on an unaffected
/// file's class is exactly as valid a typeflow target as an affected one.
/// Deliberately NOT incremental (a known prototype limitation, see the
/// evidence doc): every file is re-parsed here on every generation this
/// flag is on, independent of `urdira-jsts-syntax-worker`'s own lane-1
/// incremental cache. A file whose blob cannot be read/verified, or whose
/// syntax this prototype's extractor rejects, contributes nothing to the
/// index -- exactly as safe as it being absent, never a guess.
fn build_typeflow_program_index(
    input_files: &[SourceInput],
    resolver: &WorkspaceResolver,
    available: &BTreeSet<String>,
    files: &BTreeMap<String, SyntaxFileResult>,
) -> urdira_jsts_typeflow::ProgramIndex {
    let mut summaries: BTreeMap<String, urdira_jsts_typeflow::DeclSummary> = BTreeMap::new();
    for owner in input_files {
        let Ok(text) = read_owner_source_text(owner) else {
            continue;
        };
        if let Ok(summary) = urdira_jsts_typeflow::extract_decl_summary(&owner.path, &text) {
            summaries.insert(owner.path.clone(), summary);
        }
    }
    let mut import_targets: HashMap<(String, String, String), String> = HashMap::new();
    // P1-A: every distinct (owning_path, specifier, imported_name) triple
    // this generation's typeflow rules could ever need to close -- widened
    // from P0-S2's heritage-clauses-only collection (`class.extends`/
    // `implements`/`interface.extends`) to ALSO cover every class/interface
    // MEMBER's own declared type (a property annotation, or a method's
    // declared return type) and every top-level FUNCTION's declared return
    // type, both of which very commonly name an IMPORTED interface/class
    // (`generate(): Promise<GenerateResult>` where `GenerateResult` is
    // imported from a sibling `types/` module) -- found live: without this,
    // `resolve_raw_type_ref` silently failed to close almost every
    // cross-file member/return type, since `import_targets` had no entry
    // for a specifier/name pair no HERITAGE clause happened to also need.
    let mut needed_imports: std::collections::HashSet<(&str, &str, &str)> =
        std::collections::HashSet::new();
    for summary in summaries.values() {
        for class in &summary.classes {
            if let Some(target) = &class.extends {
                collect_heritage_import(&summary.path, target, &mut needed_imports);
            }
            for target in &class.implements {
                collect_heritage_import(&summary.path, target, &mut needed_imports);
            }
            for member in &class.members {
                collect_type_ref_import(&summary.path, &member.type_ref, &mut needed_imports);
                collect_pending_return_import(
                    &summary.path,
                    &member.pending_return,
                    &mut needed_imports,
                );
            }
        }
        for interface in &summary.interfaces {
            for target in &interface.extends {
                collect_heritage_import(&summary.path, target, &mut needed_imports);
            }
            for member in &interface.members {
                collect_type_ref_import(&summary.path, &member.type_ref, &mut needed_imports);
            }
        }
        for function in &summary.functions {
            collect_type_ref_import(&summary.path, &function.return_type, &mut needed_imports);
            collect_pending_return_import(
                &summary.path,
                &function.pending_return,
                &mut needed_imports,
            );
        }
        for shape in &summary.object_shapes {
            for member in &shape.members {
                collect_type_ref_import(&summary.path, &member.type_ref, &mut needed_imports);
                collect_pending_return_import(
                    &summary.path,
                    &member.pending_return,
                    &mut needed_imports,
                );
            }
        }
        for variable in &summary.variables {
            collect_type_ref_import(&summary.path, &variable.type_ref, &mut needed_imports);
        }
        // D.2b (2026-09-05, references-parity task): `type X = ImportedFoo`
        // -- `type_aliases` was added to `DeclSummary` by D.2 (typeflow's
        // own `build_alias_targets`/`resolve_type_ref_chasing_aliases`)
        // but this needed-imports scan never visited it, so an alias whose
        // RHS names an import had no `import_targets` entry to resolve
        // against -- see the byte-identical fix's own doc comment in
        // `v4/typeflow.rs::collect_needed_imports_for_summary`.
        for alias in &summary.type_aliases {
            collect_type_ref_import(&summary.path, &alias.target, &mut needed_imports);
        }
    }
    for (owning_path, specifier, imported_name) in needed_imports {
        let key = (
            owning_path.to_owned(),
            specifier.to_owned(),
            imported_name.to_owned(),
        );
        let Some(target_path) = resolver.resolve(owning_path, specifier, available) else {
            continue;
        };
        // 3a (urdira-jsts-syntax-worker, 2026-09-05): `resolve_named_export`
        // gained a policy parameter; `UniqueOrAmbiguous` reproduces this
        // call's exact prior behavior (v3's own typeflow import-target
        // resolution is unrelated to the overload/reference-vs-call split).
        if let ExportResolution::Resolved(target_id) = resolve_named_export(
            files,
            &target_path,
            imported_name,
            ExportPolicy::UniqueOrAmbiguous,
        ) {
            import_targets.insert(key, target_id);
        }
    }
    // E-P0d (2026-09-07): `ProgramIndex::build` gained a `pending_targets`
    // parameter (`pending_importers_of`'s own doc comment,
    // `urdira-jsts-typeflow/src/lib.rs`) so an incremental caller can retry
    // an import that resolved to a known file but not yet to a specific
    // export, once that file's content changes. This v3 prototype always
    // rebuilds `ProgramIndex` from scratch on every generation (this
    // function's own doc comment: "rebuilt from EVERY current file's source
    // text"), never calls `replace_file`/`add_file` incrementally, so it
    // has no equivalent retry mechanism to feed -- an empty map here is
    // behavior-neutral (mirrors this call's own pre-existing cold-rebuild
    // semantics exactly).
    urdira_jsts_typeflow::ProgramIndex::build(&summaries, &import_targets, &HashMap::new())
}

/// Push `(owning_path, specifier, imported_name)` into `out` when `target`
/// is a NAMED import (a default/namespace import has no `imported_name` to
/// close against, see `HeritageTarget::Imported`'s doc comment) -- shared by
/// every heritage-clause collection site in `build_typeflow_program_index`.
fn collect_heritage_import<'s>(
    owning_path: &'s str,
    target: &'s urdira_jsts_typeflow::HeritageTarget,
    out: &mut std::collections::HashSet<(&'s str, &'s str, &'s str)>,
) {
    match target {
        urdira_jsts_typeflow::HeritageTarget::Imported {
            specifier,
            imported_name: Some(imported_name),
        } => {
            out.insert((owning_path, specifier.as_str(), imported_name.as_str()));
        }
        // P1-A: `<base>.<member>(...)` heritage -- `base`'s own import
        // need (e.g. `Z` in `Z.class({...})`) is exactly the same shape,
        // one level down.
        urdira_jsts_typeflow::HeritageTarget::CallMember { base, .. } => {
            collect_heritage_import(owning_path, base, out);
        }
        _ => {}
    }
}

/// P1-A: the same collection as `collect_heritage_import`, but for a
/// member/function's own `RawTypeRef` -- recurses through `ArrayOf`/
/// `PromiseOf` wrappers to reach the leaf reference (`Promise<Foo[]>`'s
/// import need is `Foo`'s, exactly like `Foo[]`'s or a bare `Foo`'s).
fn collect_type_ref_import<'s>(
    owning_path: &'s str,
    type_ref: &'s urdira_jsts_typeflow::RawTypeRef,
    out: &mut std::collections::HashSet<(&'s str, &'s str, &'s str)>,
) {
    use urdira_jsts_typeflow::RawTypeRef;
    match type_ref {
        RawTypeRef::Imported {
            specifier,
            imported_name: Some(imported_name),
        } => {
            out.insert((owning_path, specifier.as_str(), imported_name.as_str()));
        }
        RawTypeRef::ArrayOf(inner) | RawTypeRef::PromiseOf(inner) => {
            collect_type_ref_import(owning_path, inner, out);
        }
        _ => {}
    }
}

/// P1-B: the SAME import-need collection as `collect_type_ref_import`, for
/// a `pending_return` list's own `CallEntity(ReturnEntityRef::Imported)`
/// shapes -- see `ProgramIndex::build`'s third-pass doc comment for why
/// this must run BEFORE `import_targets` is built (the fixed point closes
/// every `CallEntity` against it exactly once, up front).
fn collect_pending_return_import<'s>(
    owning_path: &'s str,
    pending_return: &'s Option<Vec<urdira_jsts_typeflow::DeferredReturnShape>>,
    out: &mut std::collections::HashSet<(&'s str, &'s str, &'s str)>,
) {
    use urdira_jsts_typeflow::{DeferredReturnShape, ReturnEntityRef};
    fn walk<'s>(
        owning_path: &'s str,
        shape: &'s DeferredReturnShape,
        out: &mut std::collections::HashSet<(&'s str, &'s str, &'s str)>,
    ) {
        match shape {
            DeferredReturnShape::CallEntity(ReturnEntityRef::Imported {
                specifier,
                imported_name: Some(imported_name),
            }) => {
                out.insert((owning_path, specifier.as_str(), imported_name.as_str()));
            }
            DeferredReturnShape::AwaitOf(inner) => walk(owning_path, inner, out),
            _ => {}
        }
    }
    let Some(shapes) = pending_return else {
        return;
    };
    for shape in shapes {
        walk(owning_path, shape, out);
    }
}

/// Pure parsing rule behind `hybrid_strict_merge` (E1c cutover invariant --
/// see the call site in `run_jsts_semantic_generation`), split out for the
/// same reason as `hybrid_semantics_enabled_from`. An explicit
/// `URDIRA_JSTS_HYBRID_STRICT_MERGE` value always wins; absent that, strict
/// mode tracks whether the hybrid lane itself is active.
fn hybrid_strict_merge_from(override_value: Option<&str>, hybrid_active: bool) -> bool {
    override_value
        .map(|value| value == "1")
        .unwrap_or(hybrid_active)
}

/// Reads and verifies one owner's source blob directly from the CAS
/// coordinate already carried on `SourceInput` (`cas_blob_path`, computed in
/// `resolve_jsts_generation_input`). This mirrors the syntax worker's own
/// private `decode_source` validation (length + sha256 digest) rather than
/// depending on it, since the syntax worker crate exposes no reusable
/// decode entry point and E1b is scoped to avoid widening that crate's
/// public surface for a single caller.
fn read_owner_source_text(owner: &SourceInput) -> Result<String, CoreError> {
    let bytes = std::fs::read(&owner.source_blob_path).map_err(|error| {
        CoreError(format!(
            "hybrid semantics: cannot read source blob for {}: {error}",
            owner.path
        ))
    })?;
    if bytes.len() != owner.byte_length {
        return Err(CoreError(format!(
            "hybrid semantics: source byte length mismatch for {}",
            owner.path
        )));
    }
    let mut digest = String::from("sha256:");
    for byte in Sha256::digest(&bytes) {
        let _ = write!(&mut digest, "{byte:02x}");
    }
    if digest != owner.content_digest {
        return Err(CoreError(format!(
            "hybrid semantics: source digest mismatch for {}",
            owner.path
        )));
    }
    String::from_utf8(bytes).map_err(|_| {
        CoreError(format!(
            "hybrid semantics: source {} is not UTF-8",
            owner.path
        ))
    })
}

/// Bounds the hybrid analysis worker count. Mirrors `facts_group_parallelism`
/// and `semantic_parallelism`'s shape (env override, else clamp to available
/// parallelism), but is independent of both: this pass runs entirely in
/// Rust, off the checker/facts-page critical path.
fn hybrid_semantics_parallelism(owner_count: usize) -> usize {
    const MAX_WORKERS: usize = 8;
    std::env::var("URDIRA_JSTS_HYBRID_PARALLELISM")
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .filter(|value| (1..=MAX_WORKERS).contains(value))
        .unwrap_or_else(|| {
            if owner_count <= 1 {
                1
            } else {
                std::thread::available_parallelism()
                    .map_or(1, |parallelism| parallelism.get())
                    .clamp(1, MAX_WORKERS)
            }
        })
}

/// Runs `analyze_owner_semantics` for every affected owner, split across a
/// bounded pool of contiguous-block worker threads (same partitioning
/// rationale as the multi-lane checker split above: predictable per-thread
/// work, no shared-queue contention). The caller is expected to run this on
/// a background thread of its own (see `run_jsts_semantic_generation`) so it
/// overlaps with the checker's own group requests instead of adding to the
/// critical path serially.
fn compute_hybrid_semantics(
    affected_paths: &[String],
    files_by_path: &HashMap<&str, &SourceInput>,
    ctx: &HybridResolutionContext<'_>,
) -> Result<HashMap<String, OwnerSemantics>, CoreError> {
    if affected_paths.is_empty() {
        return Ok(HashMap::new());
    }
    let hybrid_started = Instant::now();
    let owners = affected_paths
        .iter()
        .map(|path| {
            files_by_path
                .get(path.as_str())
                .map(|owner| (*owner).clone())
                .ok_or_else(|| {
                    CoreError(format!(
                        "hybrid semantics: affected path is outside source manifest: {path}"
                    ))
                })
        })
        .collect::<Result<Vec<SourceInput>, CoreError>>()?;
    let analyze_chunk =
        |chunk: &[SourceInput]| -> Result<Vec<(String, OwnerSemantics)>, CoreError> {
            chunk
                .iter()
                .map(|owner| {
                    let text = read_owner_source_text(owner)?;
                    let semantics = analyze_owner_semantics_with_context(&owner.path, &text, ctx)
                        .map_err(|error| {
                        CoreError(format!(
                            "hybrid semantics analysis failed for {}: {}",
                            owner.path, error.message
                        ))
                    })?;
                    Ok((owner.path.clone(), semantics))
                })
                .collect()
        };
    let worker_count = hybrid_semantics_parallelism(owners.len());
    let mut results = HashMap::with_capacity(owners.len());
    if worker_count <= 1 || owners.len() <= 1 {
        for (path, semantics) in analyze_chunk(&owners)? {
            results.insert(path, semantics);
        }
    } else {
        let block_size = owners.len().div_ceil(worker_count);
        let blocks = owners
            .chunks(block_size)
            .map(<[SourceInput]>::to_vec)
            .collect::<Vec<_>>();
        // E2: `ctx` borrows the project's `WorkspaceResolver`/available-path
        // set/resolved-files map, none of which are `'static` (they live on
        // `run_jsts_generation`'s stack). A scoped thread pool (not the
        // former `std::thread::spawn`, which requires `'static`) is what
        // makes sharing that borrow across worker threads sound.
        std::thread::scope(|scope| -> Result<(), CoreError> {
            let handles = blocks
                .into_iter()
                .map(|block| scope.spawn(move || analyze_chunk(&block)))
                .collect::<Vec<_>>();
            for handle in handles {
                let chunk_result = handle
                    .join()
                    .map_err(|_| CoreError("hybrid semantics worker thread panicked".into()))??;
                for (path, semantics) in chunk_result {
                    results.insert(path, semantics);
                }
            }
            Ok(())
        })?;
    }
    if std::env::var_os("URDIRA_DEBUG_TIMING").is_some() {
        // Safe-partition rule footprint (coordinator directive, 2026-09-01):
        // an owner tripped it iff any of its sites carries
        // `REASON_JSDOC_TYPED_FILE` -- see `semantic_sites.rs`'s
        // `is_jsdoc_typed_file`. Cheap to derive here (no new wire field)
        // since `pending_sites` is already in hand.
        let jsdoc_typed_owners = results
            .values()
            .filter(|semantics| {
                semantics
                    .pending_sites
                    .iter()
                    .any(|site| site.reason.as_deref() == Some("jsdoc_typed_file"))
            })
            .count();
        // E2 gate 5 (F5 hybrid design): owners whose `pending_sites` is
        // empty are the short-circuit candidates that could skip the
        // checker entirely once `hybrid_owner_can_skip_checker` is wired
        // live (E1c's design note: not yet, since the TypedDecl policy
        // still marks every declaration `type_inference_required`
        // unconditionally until E3). Reported here as the metric E2's own
        // evidence doc needs, without waiting on that wiring.
        let empty_pending_owners = results
            .values()
            .filter(|semantics| semantics.pending_sites.is_empty())
            .count();
        // E3 (F5 hybrid design, T1/T2): call/heritage rust_resolved vs
        // checker_pending split. `call_rows`/`heritage_rows` are exactly the
        // rust_resolved sites of their kind (never dropped for a
        // self-reference, unlike `reference_rows` -- see `visit_call_
        // expression`'s doc comment), so their counts are directly
        // comparable to the surviving `pending_sites` of the same kind.
        let rust_resolved_calls: usize = results
            .values()
            .map(|semantics| semantics.call_rows.len())
            .sum();
        let pending_calls: usize = results
            .values()
            .map(|semantics| {
                semantics
                    .pending_sites
                    .iter()
                    .filter(|site| site.site_kind == SiteKind::Call)
                    .count()
            })
            .sum();
        let rust_resolved_heritage: usize = results
            .values()
            .map(|semantics| semantics.heritage_rows.len())
            .sum();
        let pending_heritage: usize = results
            .values()
            .map(|semantics| {
                semantics
                    .pending_sites
                    .iter()
                    .filter(|site| site.site_kind == SiteKind::Heritage)
                    .count()
            })
            .sum();
        eprintln!(
            "[urdira-indexing-worker] jsts hybrid semantics owners={} elapsed_ms={} jsdoc_typed_owners={} empty_pending_owners={} calls_rust_resolved={} calls_pending={} heritage_rust_resolved={} heritage_pending={}",
            results.len(),
            hybrid_started.elapsed().as_millis(),
            jsdoc_typed_owners,
            empty_pending_owners,
            rust_resolved_calls,
            pending_calls,
            rust_resolved_heritage,
            pending_heritage
        );
    }
    Ok(results)
}

/// Design doc E1, stage E1 step 4: an owner whose hybrid analysis left
/// nothing `checker_pending` and that carries no stage-3 (typed) requirement
/// has nothing left for the checker to resolve. E1a's policy marks every
/// `TypedDecl` site `checker_pending` (`type_inference_required`)
/// unconditionally, so `pending_sites` is never actually empty yet and this
/// never fires from that policy alone.
///
/// P1-B (`checker_lane_disabled`, the caller's own `typeflow_enabled()`):
/// unconditionally `true` regardless of `semantics`/`requires_stage_three`
/// -- the checker-off pipeline mode skips the semantic lane for EVERY owner
/// in the generation, uniformly (see the `typeflow_enabled()` gate at this
/// generation's own `semantic_descriptor` construction, a few hundred lines
/// above -- THAT gate, not this function, is what actually guarantees the
/// checker subprocess is never spawned; this predicate does not depend on
/// it). A per-owner SELECTIVE skip (this function's original, narrower
/// `pending_sites.is_empty()` condition, still the `false`-branch behavior)
/// is still not wired into any live per-owner request loop: that loop keys
/// checker-response reassembly off a fixed 32-owner-per-group stride
/// (`group_index * 32 + owner_index`, see `process_owner`'s callers below),
/// and skipping a request without a matching hole in the returned owner
/// list would desynchronize every later group -- a real hazard only the
/// UNIFORM (every owner, or no owner) skip avoids, since the checker is
/// either invoked for the whole generation or not invoked at all, never for
/// a hole-riddled subset. This function itself therefore remains unwired
/// into any live call site (still only exercised by its own unit tests
/// below) -- an explicit `bool` parameter, not a direct `typeflow_enabled()`
/// read, purely so those tests can exercise both branches deterministically
/// without mutating shared process environment state.
#[allow(dead_code)]
fn hybrid_owner_can_skip_checker(
    semantics: &OwnerSemantics,
    requires_stage_three: bool,
    checker_lane_disabled: bool,
) -> bool {
    checker_lane_disabled || (semantics.pending_sites.is_empty() && !requires_stage_three)
}

/// Identity fields needed to merge or (in the empty-observations corner
/// case) synthesize a `CanonicalOwnerObservation` for one owner.
struct HybridOwnerIdentity {
    path: String,
    artifact_id: String,
    artifact_version_id: String,
}

/// P0-S2 prototype (typeflow oracle census): one miss sample, kept for
/// `docs/evidence/2026-09-02-v4-p0-s2-typeflow-prototype.md`'s report.
#[derive(Debug, Clone, Serialize, serde::Deserialize)]
struct TypeflowCensusSample {
    path: String,
    start: u32,
    end: u32,
    reason: String,
    checker_target: Option<String>,
    rust_target: Option<String>,
}

/// P0-S2 prototype (typeflow oracle census) counts for one edge kind
/// (`core:call` or `core:inherits`) -- see `census_typeflow_owner`'s doc
/// comment for exactly how each bucket is decided. Typeflow in this
/// prototype only ever emits a CONFIRMED oracle hit (never a "possible"
/// union edge, see `urdira_jsts_typeflow::MemberLookup`'s doc comment), so
/// there is no `both_possible`/`rust_possible` bucket to report: a rust miss
/// is always "still pending", never "possible".
#[derive(Debug, Clone, Default, Serialize, serde::Deserialize)]
struct TypeflowEdgeCensus {
    /// Every `pending_sites` entry in this edge kind's own scope (the exact
    /// reason typeflow widens -- `call_deferred_to_e3`/
    /// `heritage_deferred_to_e3`), regardless of whether typeflow itself
    /// attempted or resolved it. The denominator for a recovery rate is
    /// `both_confirmed_same_target / (both_confirmed_same_target +
    /// both_confirmed_different_target + checker_confirmed_rust_pending)`
    /// -- the "checker-confirmed workspace-target sites" the task's
    /// acceptance bar asks for.
    attempted_sites: usize,
    both_confirmed_same_target: usize,
    both_confirmed_different_target: usize,
    /// Checker confirmed a WORKSPACE-declared target (never under
    /// `node_modules/`, e.g. TypeScript's own `lib.*.d.ts` ambient
    /// declarations) that typeflow left pending -- this IS the
    /// denominator's third term for the task's own "checker-confirmed
    /// workspace-target sites" recovery rate.
    checker_confirmed_rust_pending: usize,
    /// Checker confirmed a target OUTSIDE the workspace (TypeScript's
    /// standard library ambient declarations: `Array.prototype.filter`,
    /// `console.log`, `Map`/`Set`/`JSON`/`Object`/`RegExp` methods, ...).
    /// This crate's `ProgramIndex` only ever indexes workspace source
    /// files' own class/interface declarations (see its module doc), so
    /// typeflow can NEVER resolve one of these by construction -- tracked
    /// separately, and deliberately EXCLUDED from the recovery-rate
    /// denominator, rather than folded into `checker_confirmed_rust_
    /// pending` and silently deflating the rate against a target class this
    /// prototype was never scoped to reach.
    checker_confirmed_external_target: usize,
    checker_possible_or_missing_rust_confirmed: usize,
    both_pending_or_possible: usize,
    // `default` is required alongside `skip_serializing_if`: the latter
    // only omits the key when EMPTY on write, but the derived
    // `Deserialize` impl still demands every field be present unless it
    // also has a default -- without this, `write_typeflow_census`'s own
    // read-back of a file it just wrote (whenever a sample vec was empty)
    // fails to parse, `.ok()` swallows the error, and the next generation's
    // read-merge-write silently discards everything accumulated so far.
    // Found live: a rich 48k-site cold census vanished on the very next
    // (2-owner) mutation generation because of exactly this.
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    different_target_samples: Vec<TypeflowCensusSample>,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    checker_confirmed_rust_pending_samples: Vec<TypeflowCensusSample>,
}

#[derive(Debug, Clone, Default, Serialize, serde::Deserialize)]
struct TypeflowCensus {
    calls: TypeflowEdgeCensus,
    heritage: TypeflowEdgeCensus,
    /// Diagnostic (P0-S2 debugging, 2026-09-02): how many owners actually
    /// reached `census_typeflow_owner` at all (i.e. had a non-empty
    /// `hybrid_semantics` entry). If this stays far below the corpus size,
    /// the gap is upstream of typeflow entirely (hybrid lane not running
    /// for most owners), not a typeflow rule-coverage problem.
    owners_censused: usize,
    /// Diagnostic: every `SiteKind::Call`/`SiteKind::Heritage` pending
    /// site's own `reason` string, tallied regardless of whether it matches
    /// typeflow's own scope. Lets a report distinguish "typeflow's rules
    /// under-cover the corpus" (many sites, wrong reasons) from "the corpus
    /// barely reaches the checker_pending stage at all" (few sites, period).
    call_and_heritage_reason_counts: std::collections::BTreeMap<String, usize>,
    /// Diagnostic: how many typeflow oracle hits (resolved sites) came from
    /// each originating rule (`this`, `super`, `member_declared_type`,
    /// `member_new_expression`, `member_class_static`, `heritage_generic`,
    /// and P1-A's chain rules -- `call_return_type`, `call_chain_this_
    /// return`, `member_declared_type_chain`, `array_element`, `await`,
    /// `as_expression`, `type_assertion`, `non_null`, `parenthesized`).
    resolved_by_rule: std::collections::BTreeMap<String, usize>,
    /// P1-A step 1 (classifier): for every `calls.checker_confirmed_rust_
    /// pending` site, the receiver-expression SHAPE tally (`SemanticWalker::
    /// classify_receiver_shape`'s taxonomy) -- drives which rule to
    /// implement next, ranked by frequency. Keyed by shape name.
    receiver_shape_counts: std::collections::BTreeMap<String, usize>,
    /// Up to 5 samples per shape (kept small -- this is for picking
    /// representative snippets to read, not a full corpus dump; the
    /// unfiltered miss list is `calls.checker_confirmed_rust_pending_
    /// samples`, capped at `TYPEFLOW_CENSUS_SAMPLE_CAP`).
    #[serde(skip_serializing_if = "std::collections::BTreeMap::is_empty", default)]
    receiver_shape_samples: std::collections::BTreeMap<String, Vec<TypeflowCensusSample>>,
    /// P1-A step 5: for every `calls.checker_confirmed_external_target`
    /// site, the checker's target entity id's own `.d.ts` FILE basename
    /// (`lib.es5.d.ts`, `lib.es2015.promise.d.ts`, `lib.dom.d.ts`, a
    /// `@types/node` path, ...) -- a coarse but cheap proxy for "which
    /// built-in surface (Array/Promise/Map/String vs. DOM vs. Node) is
    /// actually being missed", so P1-B can decide whether a tiny built-in
    /// member table is worth adding. See `external_target_basename`.
    external_target_basename_counts: std::collections::BTreeMap<String, usize>,
    /// P1-C: a SEPARATE census, same shape as `calls`, scoped to `reason ==
    /// "call_target_uncertain"` sites (a plain IDENTIFIER callee E1-E3
    /// tried and could not confirm -- structurally disjoint from `calls`,
    /// which is scoped to `call_deferred_to_e3`, a callee E1-E3 never even
    /// attempted: member/`this`/`super`/any non-identifier expression).
    /// Found live, and large -- `call_and_heritage_reason_counts` shows
    /// 27,683 such sites on this corpus, more than half again as many as
    /// `calls.attempted_sites` itself -- once `destructured_member_
    /// entities` (P1-C, `semantic_sites.rs`) started resolving a BARE call
    /// to a destructured-method identifier (`await dropColumns(...)`, the
    /// migration DSL's own dominant pattern), that resolution shows up
    /// here, never in `calls` (whose own denominator this session
    /// deliberately did NOT redefine, to keep P1-A/P1-B's own recovery
    /// number comparable across sessions). Kept as its own independent
    /// recovery rate rather than folded into `calls`' total.
    #[serde(default)]
    identifier_calls: TypeflowEdgeCensus,
}

const TYPEFLOW_CENSUS_SAMPLE_CAP: usize = 1000;
/// Small, separate cap for `receiver_shape_samples` (see its own doc
/// comment) -- kept far below `TYPEFLOW_CENSUS_SAMPLE_CAP` so raising the
/// main miss-sample cap to 1000 does not also balloon the per-shape sample
/// listing to the same size.
const TYPEFLOW_SHAPE_SAMPLE_CAP: usize = 5;
/// Must match `urdira_jsts_syntax_worker::semantic_sites`'s own
/// `REASON_CALL_DEFERRED`/`REASON_HERITAGE_DEFERRED` constants byte for
/// byte -- not exported (private to that crate's implementation), so
/// duplicated here as plain string literals rather than widening that
/// crate's public surface for a prototype-only consumer.
const TYPEFLOW_REASON_CALL_DEFERRED: &str = "call_deferred_to_e3";
const TYPEFLOW_REASON_HERITAGE_DEFERRED: &str = "heritage_deferred_to_e3";
/// P1-C: must match `urdira_jsts_syntax_worker::semantic_sites`'s own
/// `REASON_CALL_TARGET_UNCERTAIN` byte for byte -- see `TypeflowCensus::
/// identifier_calls`'s doc comment for why this is measured separately
/// from `TYPEFLOW_REASON_CALL_DEFERRED`.
const TYPEFLOW_REASON_CALL_TARGET_UNCERTAIN: &str = "call_target_uncertain";

/// P0-S2 prototype (typeflow oracle census, `URDIRA_JSTS_TYPEFLOW_ORACLE=1`
/// only): for every `pending_sites` entry in typeflow's own scope (a
/// member-access/`this`/`super` call, or a class's own generic `extends`),
/// cross-reference the checker's OWN canonical `core:call`/`core:inherits`
/// row at that exact span (read from `observations` BEFORE the hybrid merge
/// appends anything -- these are the checker's independent answer, since
/// oracle mode never removes the site from `pending_sites`, see
/// `HybridResolutionContext::typeflow_oracle`'s doc comment) against
/// typeflow's own guess (`semantics.typeflow_oracle_hits`, keyed by the
/// same span). A site typeflow itself never attempted (an unsupported
/// shape, e.g. a 2-hop member chain) or attempted and missed both show up
/// identically here as "no oracle hit" -- this prototype does not
/// distinguish "did not try" from "tried and failed", since both mean the
/// exact same thing to a caller deciding whether this rule set is ready to
/// take over the site.
/// Whether an E0 entity id (`jsts:{kind}:{path}:{start}:{name}`) names a
/// declaration inside THIS workspace, as opposed to TypeScript's own
/// standard library (`lib.*.d.ts`, always reached through a `node_modules/`
/// path segment in this pnpm-managed corpus). Used only to keep the oracle
/// census's recovery-rate denominator scoped to what this prototype was
/// ever meant to reach -- see `TypeflowEdgeCensus::checker_confirmed_
/// external_target`'s doc comment.
fn is_workspace_target(target_id: &str) -> bool {
    !target_id.contains("/node_modules/")
}

/// P1-A step 5: a coarse bucket name for a `checker_confirmed_external_
/// target` entity id's own declaring FILE -- see `TypeflowCensus::
/// external_target_basename_counts`'s doc comment. `target_id`'s embedded
/// path (`jsts:{kind}:{path}:{start}:{name}`) is a `.d.ts` file under
/// `node_modules/` by construction (only reached via `is_workspace_target`
/// returning false); every `@types/<pkg>` package (starting with `@types/
/// node`, the only one this corpus's sampled misses hit) is folded into one
/// `@types/<pkg>/<basename>` bucket so its many small files (`fs.d.ts`,
/// `buffer.d.ts`, ...) still group under a recognizable package name, while
/// TypeScript's OWN standard library files (`lib.es5.d.ts`, `lib.dom.d.ts`,
/// `lib.es2015.promise.d.ts`, ...) already self-describe by basename alone.
fn external_target_basename(target_id: &str) -> String {
    let path = target_id.split(':').nth(2).unwrap_or("");
    let basename = path.rsplit('/').next().unwrap_or(path);
    if let Some(at_types) = path.rfind("/node_modules/@types/") {
        let rest = &path[at_types + "/node_modules/@types/".len()..];
        let package = rest.split('/').next().unwrap_or(rest);
        return format!("@types/{package}/{basename}");
    }
    // pnpm's own store layout for a scoped package (`@types/node@20.x`)
    // nests it under `.pnpm/@types+node@<version>/node_modules/@types/node/`
    // -- already covered by the `/node_modules/@types/` check above since
    // that literal substring still appears once in the resolved path
    // (pnpm's `node_modules/@types/<pkg>` symlink target). Anything else is
    // TypeScript's own `lib.*.d.ts` (or another ambient global) -- basename
    // alone is already the useful bucket.
    basename.to_owned()
}

fn census_typeflow_owner(
    observations: &[urdira_indexing_core::CanonicalOwnerObservation],
    semantics: &OwnerSemantics,
    owner_path: &str,
    census: &mut TypeflowCensus,
) {
    type CheckerEdgeSpans = HashMap<(u32, u32), Vec<(String, Option<String>)>>;
    census.owners_censused += 1;
    for hit in &semantics.typeflow_oracle_hits {
        *census
            .resolved_by_rule
            .entry(hit.rule.to_owned())
            .or_insert(0) += 1;
    }
    for site in &semantics.pending_sites {
        if site.site_kind == SiteKind::Call || site.site_kind == SiteKind::Heritage {
            *census
                .call_and_heritage_reason_counts
                .entry(site.reason.clone().unwrap_or_else(|| "<none>".to_owned()))
                .or_insert(0) += 1;
        }
    }
    if semantics.pending_sites.is_empty() {
        return;
    }
    let mut checker_calls: CheckerEdgeSpans = HashMap::new();
    let mut checker_heritage: CheckerEdgeSpans = HashMap::new();
    for observation in observations {
        for row in &observation.canonical_records {
            let Ok(parsed) = serde_json::from_str::<Value>(row) else {
                continue;
            };
            let bucket = match parsed.get("universal_kind").and_then(Value::as_str) {
                Some("core:call") => &mut checker_calls,
                Some("core:inherits") => &mut checker_heritage,
                _ => continue,
            };
            let body = parsed.get("body");
            let (Some(start), Some(end)) = (
                body.and_then(|b| b.get("start")).and_then(Value::as_u64),
                body.and_then(|b| b.get("end")).and_then(Value::as_u64),
            ) else {
                continue;
            };
            let classification = body
                .and_then(|b| b.get("classification"))
                .and_then(Value::as_str)
                .unwrap_or("possible")
                .to_owned();
            let target = body
                .and_then(|b| b.get("target_id"))
                .and_then(Value::as_str)
                .map(str::to_owned);
            bucket
                .entry((start as u32, end as u32))
                .or_default()
                .push((classification, target));
        }
    }
    let oracle_calls: HashMap<(u32, u32), &str> = semantics
        .typeflow_oracle_hits
        .iter()
        .filter(|hit| hit.edge_kind == "call")
        .map(|hit| ((hit.start, hit.end), hit.target_id.as_str()))
        .collect();
    let oracle_heritage: HashMap<(u32, u32), &str> = semantics
        .typeflow_oracle_hits
        .iter()
        .filter(|hit| hit.edge_kind == "inherits")
        .map(|hit| ((hit.start, hit.end), hit.target_id.as_str()))
        .collect();
    // P1-A step 1 (classifier): every non-identifier-callee call site's
    // receiver shape, keyed by span -- see `OwnerSemantics::typeflow_
    // pending_call_shapes`'s doc comment.
    let pending_shapes: HashMap<(u32, u32), &'static str> = semantics
        .typeflow_pending_call_shapes
        .iter()
        .map(|shape| ((shape.start, shape.end), shape.shape))
        .collect();
    for site in &semantics.pending_sites {
        let is_call = site.site_kind == SiteKind::Call
            && site.reason.as_deref() == Some(TYPEFLOW_REASON_CALL_DEFERRED);
        let is_heritage = site.site_kind == SiteKind::Heritage
            && site.reason.as_deref() == Some(TYPEFLOW_REASON_HERITAGE_DEFERRED);
        // P1-C: see `TypeflowCensus::identifier_calls`'s doc comment.
        let is_identifier_call = site.site_kind == SiteKind::Call
            && site.reason.as_deref() == Some(TYPEFLOW_REASON_CALL_TARGET_UNCERTAIN);
        if !is_call && !is_heritage && !is_identifier_call {
            continue;
        }
        let (edge_census, checker_by_span, oracle_by_span) = if is_call {
            (&mut census.calls, &checker_calls, &oracle_calls)
        } else if is_identifier_call {
            (&mut census.identifier_calls, &checker_calls, &oracle_calls)
        } else {
            (&mut census.heritage, &checker_heritage, &oracle_heritage)
        };
        edge_census.attempted_sites += 1;
        let span = (site.start_utf16, site.end_utf16);
        let checker_confirmed_target = checker_by_span
            .get(&span)
            .and_then(|rows| {
                rows.iter()
                    .find(|(classification, _)| classification == "confirmed")
            })
            .and_then(|(_, target)| target.clone());
        let rust_target = oracle_by_span.get(&span).map(|target| (*target).to_owned());
        match (&checker_confirmed_target, &rust_target) {
            (Some(checker_target), Some(rust_target)) if checker_target == rust_target => {
                edge_census.both_confirmed_same_target += 1;
            }
            (Some(_), Some(_)) => {
                edge_census.both_confirmed_different_target += 1;
                if edge_census.different_target_samples.len() < TYPEFLOW_CENSUS_SAMPLE_CAP {
                    edge_census
                        .different_target_samples
                        .push(TypeflowCensusSample {
                            path: owner_path.to_owned(),
                            start: site.start_utf16,
                            end: site.end_utf16,
                            reason: site.reason.clone().unwrap_or_default(),
                            checker_target: checker_confirmed_target.clone(),
                            rust_target: rust_target.clone(),
                        });
                }
            }
            (Some(checker_target), None) if !is_workspace_target(checker_target) => {
                // TypeScript's own standard library (`lib.*.d.ts`, always
                // under `node_modules/`) -- this crate's `ProgramIndex`
                // never indexes anything outside workspace source files
                // (see `TypeflowEdgeCensus::checker_confirmed_external_
                // target`'s doc comment), so this is out of scope BY
                // CONSTRUCTION, not a rule gap, and must not deflate the
                // recovery-rate denominator.
                edge_census.checker_confirmed_external_target += 1;
                *census
                    .external_target_basename_counts
                    .entry(external_target_basename(checker_target))
                    .or_insert(0) += 1;
            }
            (Some(_), None) => {
                edge_census.checker_confirmed_rust_pending += 1;
                if edge_census.checker_confirmed_rust_pending_samples.len()
                    < TYPEFLOW_CENSUS_SAMPLE_CAP
                {
                    edge_census
                        .checker_confirmed_rust_pending_samples
                        .push(TypeflowCensusSample {
                            path: owner_path.to_owned(),
                            start: site.start_utf16,
                            end: site.end_utf16,
                            reason: site.reason.clone().unwrap_or_default(),
                            checker_target: checker_confirmed_target.clone(),
                            rust_target: None,
                        });
                }
                // P1-A step 1 (classifier): only calls carry a receiver
                // shape (`typeflow_pending_call_shapes` is call-site-only,
                // see its doc comment) -- heritage misses are excluded here,
                // not double-counted under some default shape.
                if is_call && let Some(shape) = pending_shapes.get(&span) {
                    *census
                        .receiver_shape_counts
                        .entry((*shape).to_owned())
                        .or_insert(0) += 1;
                    let samples = census
                        .receiver_shape_samples
                        .entry((*shape).to_owned())
                        .or_default();
                    if samples.len() < TYPEFLOW_SHAPE_SAMPLE_CAP {
                        samples.push(TypeflowCensusSample {
                            path: owner_path.to_owned(),
                            start: site.start_utf16,
                            end: site.end_utf16,
                            reason: site.reason.clone().unwrap_or_default(),
                            checker_target: checker_confirmed_target.clone(),
                            rust_target: None,
                        });
                    }
                }
            }
            (None, Some(_)) => {
                edge_census.checker_possible_or_missing_rust_confirmed += 1;
            }
            (None, None) => {
                edge_census.both_pending_or_possible += 1;
            }
        }
    }
}

/// One classified non-colliding row, kept for the pre-E1c census the owner
/// asked for. `checker_identity_keys` is empty for class B.
#[derive(Debug, Clone)]
struct HybridClassExample {
    owner_path: String,
    start: u64,
    end: u64,
    rust_identity_key: String,
    checker_identity_keys: Vec<String>,
}

#[derive(Debug)]
struct HybridMergeStats {
    attempted: usize,
    collisions: usize,
    merged: usize,
    example_collision_key: Option<String>,
    /// Class A: same `(start, end)` span carries at least one checker
    /// `core:references` row, but with a different `identity_key` (i.e. a
    /// different resolved source/target) -- a genuine binder-vs-checker
    /// resolution disagreement. Dangerous: E1c cannot retire the checker's
    /// emission for these sites without first deciding who is right.
    class_a_disagreements: usize,
    /// Class B: no checker `core:references` row exists at that span at
    /// all -- an omission on the checker's walk. Benign if Rust is right.
    class_b_omissions: usize,
    class_a_examples: Vec<HybridClassExample>,
    class_b_examples: Vec<HybridClassExample>,
}

/// Converts one hybrid-lane `ProposedRecord` into the same
/// `StructuralKernelRecord` shape the syntax lane already builds from the
/// (structurally identical) checker-protocol `ProposedRecord` in
/// `run_jsts_generation` above, so both lanes canonicalize through the same
/// native kernel function and can never diverge in row format.
fn hybrid_structural_record(
    record: &ProposedRecord,
) -> urdira_indexing_core::StructuralKernelRecord {
    urdira_indexing_core::StructuralKernelRecord {
        proposal_record_key: record.proposal_record_key.clone(),
        category: record.category.to_owned(),
        kind: record.kind.clone(),
        universal_kind: record.universal_kind.clone(),
        facets: record.facets.clone(),
        schema_version: u32::from(record.schema_version),
        source_span: record.source_span.clone(),
        identity_key: record.identity_key.clone(),
        // A3b: `ProposedRecord::body` is now `RecordBody` (`Value` or
        // `Encoded`); `StructuralKernelRecord::body` is still a plain
        // `Value` (this v3/checker hybrid lane's own shape, untouched by
        // this task) -- decode on demand rather than clone directly.
        body: record.body.to_value(),
        evidence_references: record.evidence_references.clone(),
    }
}

/// Canonicalizes `records` through the structural kernel while respecting
/// the kernel's own per-call bounds (`MAX_BATCH_RECORDS` rows /
/// `MAX_BATCH_FRAMED_BYTES` framed bytes -- the same authoritative constants
/// `append_bounded_hybrid_rows` pages against below, re-exported from
/// `urdira-native-core` via `urdira-indexing-core`). A single
/// `structural_kernel_batch_parts` call enforces both bounds atomically
/// across every record it is given (`structural_kernel_batch_parts_with_canonical`),
/// so an owner whose hybrid row count -- or framed byte size, even under
/// 4,096 rows -- exceeds either one must be canonicalized across multiple
/// kernel calls instead of one ("hybrid reference row canonicalization
/// failed ... Structural kernel batch exceeds the 4096-row bound").
///
/// This is sound to do because each record's canonical text, digest, and id
/// are derived purely from that record (see the per-record loop in
/// `structural_kernel_batch_parts_with_canonical`): no row's canonical
/// output depends on which other rows share its batch. The only batch-level
/// values the kernel also computes -- `records_digest`, `dependencies_digest`,
/// `publication_descriptor`, etc. -- are aggregates over one call's slice,
/// and this function (like its only caller) never reads them, only
/// `canonical_records`. Concatenating the canonical rows from N calls in
/// row order is therefore byte-identical to what one (hypothetically
/// unbounded) call would have produced.
fn canonicalize_structural_records_bounded(
    records: &[urdira_indexing_core::StructuralKernelRecord],
) -> Result<Vec<String>, String> {
    let mut canonical = Vec::with_capacity(records.len());
    for row_chunk in records.chunks(urdira_indexing_core::MAX_BATCH_RECORDS) {
        canonicalize_structural_chunk(row_chunk, &mut canonical)?;
    }
    Ok(canonical)
}

/// Canonicalizes one row-bounded chunk (`chunk.len() <= MAX_BATCH_RECORDS`),
/// appending its canonical rows to `out` in order. If the kernel rejects the
/// chunk -- most likely `MAX_BATCH_FRAMED_BYTES`, since the caller already
/// bounds rows -- the chunk is bisected and each half retried recursively
/// until every sub-chunk fits or (for a single record that still fails,
/// e.g. a genuine schema/canonical-form defect unrelated to batch size) the
/// kernel's own error is returned as-is. A rejection anywhere aborts the
/// whole call via `?` before `out` is ever handed back to the caller, so
/// canonicalization stays fail-closed for the owner exactly as before this
/// function existed -- chunking only changes how many kernel calls it takes
/// to reach that same all-or-nothing outcome.
fn canonicalize_structural_chunk(
    chunk: &[urdira_indexing_core::StructuralKernelRecord],
    out: &mut Vec<String>,
) -> Result<(), String> {
    if chunk.is_empty() {
        return Ok(());
    }
    match urdira_indexing_core::structural_kernel_batch_parts(chunk, &[]) {
        Ok(sealed) => {
            out.extend(sealed.canonical_records);
            Ok(())
        }
        Err(_) if chunk.len() > 1 => {
            let mid = chunk.len() / 2;
            canonicalize_structural_chunk(&chunk[..mid], out)?;
            canonicalize_structural_chunk(&chunk[mid..], out)
        }
        Err(error) => Err(error.to_string()),
    }
}

/// Merges the hybrid Rust reference rows (E1a's `analyze_owner_semantics`)
/// AND the `core:covers` rows synthesized alongside them (F5 hybrid gap fix,
/// 2026-09-01: `OwnerSemantics::covers_rows`, `semantic_sites.rs`'s
/// `covers_proposed_record`) into the checker-produced canonical
/// observations for one owner. Every row -- reference or covers -- is
/// checked against the checker's own canonical rows for the same owner by
/// `identity_key` first: the design's partition contract (Rust only asserts
/// what it can prove lexically, the checker still emits everything in
/// E1a/E1b) makes a collision a genuine double-emission bug -- risk #3 in
/// the design doc -- not an expected outcome. For a covers row this
/// dedup-by-identity is what makes it safe for the checker to ALSO derive a
/// covers row for the same `testContainer -> target` pair through a
/// DIFFERENT reference (a different `identity_key`, since that key embeds
/// the underlying reference's own span): the two rows are never expected to
/// collide (see `OwnerSemantics::covers_rows`'s doc comment for why the
/// partition invariant already rules that out for reference rows, and
/// transitively for covers), but if they ever did, this is the single choke
/// point that keeps the merge to one row. `strict` fails the generation
/// closed with the offending key; the default (`strict = false`, i.e. "dry"
/// mode) counts and skips the colliding row instead so a full corpus run can
/// finish and report the *complete* collision census in one pass, which is
/// the more useful signal ahead of E1c actually retiring the checker's own
/// reference emission.
fn merge_hybrid_reference_rows(
    observations: &mut Vec<urdira_indexing_core::CanonicalOwnerObservation>,
    semantics: &OwnerSemantics,
    owner: &HybridOwnerIdentity,
    strict: bool,
) -> Result<HybridMergeStats, CoreError> {
    let mut stats = HybridMergeStats {
        attempted: semantics.reference_rows.len()
            + semantics.covers_rows.len()
            + semantics.call_rows.len()
            + semantics.heritage_rows.len()
            + semantics.typeflow_call_rows.len()
            + semantics.typeflow_heritage_rows.len(),
        collisions: 0,
        merged: 0,
        example_collision_key: None,
        class_a_disagreements: 0,
        class_b_omissions: 0,
        class_a_examples: Vec::new(),
        class_b_examples: Vec::new(),
    };
    if semantics.reference_rows.is_empty()
        && semantics.covers_rows.is_empty()
        && semantics.call_rows.is_empty()
        && semantics.heritage_rows.is_empty()
        && semantics.typeflow_call_rows.is_empty()
        && semantics.typeflow_heritage_rows.is_empty()
    {
        return Ok(stats);
    }
    let mut existing_identity_keys = HashSet::new();
    // Span index of the checker's own `core:references` rows for this owner,
    // keyed by `(start, end)`. Lets a non-colliding hybrid row be classified
    // (owner's pre-E1c census request) as class A -- same span, a checker
    // row exists there but names a different source/target, a genuine
    // binder-vs-checker resolution disagreement -- versus class B -- no
    // checker reference row exists at that span at all, a checker omission.
    let mut existing_reference_spans: HashMap<(u64, u64), Vec<String>> = HashMap::new();
    for observation in observations.iter() {
        for row in &observation.canonical_records {
            let Ok(parsed) = serde_json::from_str::<Value>(row) else {
                continue;
            };
            let Some(key) = parsed.get("identity_key").and_then(Value::as_str) else {
                continue;
            };
            existing_identity_keys.insert(key.to_owned());
            if parsed.get("universal_kind").and_then(Value::as_str) == Some("core:references")
                && let (Some(start), Some(end)) = (
                    parsed
                        .get("body")
                        .and_then(|body| body.get("start"))
                        .and_then(Value::as_u64),
                    parsed
                        .get("body")
                        .and_then(|body| body.get("end"))
                        .and_then(Value::as_u64),
                )
            {
                existing_reference_spans
                    .entry((start, end))
                    .or_default()
                    .push(key.to_owned());
            }
        }
    }
    // Reference rows and their derived covers rows canonicalize through the
    // same native kernel call, in one shot, so both share the identical
    // sealing/paging behavior below -- a covers row is just another kind of
    // hybrid row from this owner's perspective. E3 (F5 hybrid design)
    // widens this the same way: `call_rows`/`heritage_rows` are `core:call`/
    // `core:inherits`/`core:implements` rows the walker resolved with the
    // same lexical-certainty contract as a reference row, so they share the
    // identical collision-dedup/census/paging pipeline below rather than a
    // parallel one.
    let structural_records = semantics
        .reference_rows
        .iter()
        .chain(semantics.covers_rows.iter())
        .chain(semantics.call_rows.iter())
        .chain(semantics.heritage_rows.iter())
        .chain(semantics.typeflow_call_rows.iter())
        .chain(semantics.typeflow_heritage_rows.iter())
        .map(hybrid_structural_record)
        .collect::<Vec<_>>();
    let sealed_canonical_records = canonicalize_structural_records_bounded(&structural_records)
        .map_err(|error| {
            CoreError(format!(
                "hybrid reference row canonicalization failed for {}: {error}",
                owner.path
            ))
        })?;
    const MAX_EXAMPLES_PER_OWNER: usize = 5;
    let mut merged_records = Vec::with_capacity(structural_records.len());
    for (record, canonical) in structural_records.iter().zip(sealed_canonical_records) {
        if existing_identity_keys.contains(&record.identity_key) {
            stats.collisions += 1;
            if stats.example_collision_key.is_none() {
                stats.example_collision_key = Some(record.identity_key.clone());
            }
            if strict {
                return Err(CoreError(format!(
                    "hybrid semantics double emission detected: identity_key {} was proposed by both the checker and the Rust oxc_semantic reference resolver for owner {}",
                    record.identity_key, owner.path
                )));
            }
            continue;
        }
        // Class A/B census is specifically about reference-resolution
        // disagreement between the binder and the checker; a `core:covers`
        // row's `(start, end)` is the underlying reference's own span (see
        // `covers_proposed_record`'s doc comment), which would otherwise
        // false-positive against `existing_reference_spans` here -- gate the
        // classification to reference rows only, same as before this
        // function also merged covers rows.
        if record.universal_kind == "core:references" {
            let start = record.body.get("start").and_then(Value::as_u64);
            let end = record.body.get("end").and_then(Value::as_u64);
            let same_span_checker_keys = start
                .zip(end)
                .and_then(|span| existing_reference_spans.get(&span));
            match same_span_checker_keys {
                Some(keys) if !keys.is_empty() => {
                    stats.class_a_disagreements += 1;
                    if stats.class_a_examples.len() < MAX_EXAMPLES_PER_OWNER {
                        stats.class_a_examples.push(HybridClassExample {
                            owner_path: owner.path.clone(),
                            start: start.unwrap_or_default(),
                            end: end.unwrap_or_default(),
                            rust_identity_key: record.identity_key.clone(),
                            checker_identity_keys: keys.clone(),
                        });
                    }
                }
                _ => {
                    stats.class_b_omissions += 1;
                    if stats.class_b_examples.len() < MAX_EXAMPLES_PER_OWNER {
                        stats.class_b_examples.push(HybridClassExample {
                            owner_path: owner.path.clone(),
                            start: start.unwrap_or_default(),
                            end: end.unwrap_or_default(),
                            rust_identity_key: record.identity_key.clone(),
                            checker_identity_keys: Vec::new(),
                        });
                    }
                }
            }
        }
        merged_records.push(canonical);
    }
    stats.merged = merged_records.len();
    append_bounded_hybrid_rows(observations, owner, merged_records);
    Ok(stats)
}

/// Appends hybrid (Rust-produced) `core:references` rows to `observations`
/// while respecting the same physical bounds every other canonical batch
/// answers to: `MAX_BATCH_RECORDS` rows / `MAX_BATCH_FRAMED_BYTES` bytes per
/// single `CanonicalOwnerObservation`. These are urdira-native-core's own
/// per-batch constants -- the authoritative bound, because
/// `structural_kernel_canonical_batch_parts_with_records` enforces exactly
/// them, per observation, at acceptance time (see
/// `accept_canonical_group_owned`). They are deliberately NOT
/// `urdira_indexing_core::MAX_GROUP_ROWS`/`MAX_GROUP_BYTES`: those bound the
/// *group* (many observations, up to `MAX_GROUP_OWNERS` owners, summed) and
/// happen to share the row value (4,096 == `MAX_BATCH_RECORDS`) but not the
/// byte value (16 MiB vs. `MAX_BATCH_FRAMED_BYTES`'s 4 MiB) -- using the
/// group byte bound here under-pages a single observation.
///
/// `merge_hybrid_reference_rows` previously appended every hybrid row to
/// the owner's last observation unconditionally; a giant owner whose
/// checker rows already sat near either bound then overflowed it once
/// hybrid rows were added ("Structural canonical batch exceeds the
/// 4096-row bound", and -- once the row bound alone was fixed but this
/// function was still budgeting against the 16 MiB group bound instead of
/// the real 4 MiB per-observation bound -- "Structural canonical batch
/// exceeds the 4194304-byte bound").
///
/// The fix treats hybrid rows exactly like a checker cursor continuation:
/// top off the owner's current final page up to the bound, then open
/// additional pages (next `sequence`, same owner identity) for the
/// remainder, carrying `final_batch` forward onto the new tail page. This
/// is the same receipt lineage a giant owner already uses when the checker
/// itself pages it (`analyze_semantic_pages`), so downstream group
/// accumulation, receipts, and the `seal()` contiguity/finality checks
/// need no changes. When the owner's existing pages already have room for
/// every hybrid row (the common case measured at 2,000-owner scale), this
/// is byte-identical to the previous unconditional `extend`.
fn append_bounded_hybrid_rows(
    observations: &mut Vec<urdira_indexing_core::CanonicalOwnerObservation>,
    owner: &HybridOwnerIdentity,
    merged_records: Vec<String>,
) {
    if merged_records.is_empty() {
        return;
    }
    const MAX_ROWS: usize = urdira_indexing_core::MAX_BATCH_RECORDS;
    const MAX_BYTES: usize = urdira_indexing_core::MAX_BATCH_FRAMED_BYTES;
    fn observation_rows(observation: &urdira_indexing_core::CanonicalOwnerObservation) -> usize {
        observation.canonical_records.len() + observation.canonical_dependencies.len()
    }
    fn observation_bytes(observation: &urdira_indexing_core::CanonicalOwnerObservation) -> usize {
        observation
            .canonical_records
            .iter()
            .chain(observation.canonical_dependencies.iter())
            .map(String::len)
            .sum()
    }
    let mut next_sequence = observations
        .iter()
        .map(|observation| observation.sequence)
        .max()
        .map_or(0, |sequence| sequence.saturating_add(1));
    // Start by topping off whichever observation currently carries the
    // owner's highest sequence number -- the checker's own final page, or
    // (if there is none) nothing, in which case the first hybrid page
    // below opens sequence 0.
    let mut target = observations
        .iter()
        .enumerate()
        .max_by_key(|(_, observation)| observation.sequence)
        .map(|(index, _)| index);
    let (mut rows, mut bytes) = target
        .map(|index| {
            (
                observation_rows(&observations[index]),
                observation_bytes(&observations[index]),
            )
        })
        .unwrap_or((0, 0));
    for canonical in merged_records {
        let canonical_len = canonical.len();
        let has_room =
            target.is_some() && rows < MAX_ROWS && bytes.saturating_add(canonical_len) <= MAX_BYTES;
        let index = if has_room {
            target.expect("has_room implies a target index")
        } else {
            if let Some(previous) = target {
                // The previous tail page is now full: it stops being the
                // owner's final page, and the freshly opened page below
                // takes over that role.
                observations[previous].final_batch = false;
            }
            observations.push(urdira_indexing_core::CanonicalOwnerObservation {
                owner_artifact_id: owner.artifact_id.clone(),
                owner_artifact_version_id: owner.artifact_version_id.clone(),
                owner_path: owner.path.clone(),
                lane: "semantic".into(),
                sequence: next_sequence,
                final_batch: true,
                canonical_records: Vec::new(),
                canonical_dependencies: Vec::new(),
                byte_length: 0,
                owner_digest: String::new(),
                fact_delta_id: None,
                delta_digest: None,
                diagnostic_codes: Vec::new(),
            });
            next_sequence = next_sequence.saturating_add(1);
            rows = 0;
            bytes = 0;
            observations.len() - 1
        };
        observations[index].canonical_records.push(canonical);
        rows += 1;
        bytes = bytes.saturating_add(canonical_len);
        target = Some(index);
    }
}

impl Drop for SemanticChecker {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let _publication_sql_digest = publication_v3_sql::PUBLICATION_V3_SQL_DIGEST;
    let mut decoder = FrameDecoder::default();
    struct ActiveOperation {
        request: GenerationRequest,
        core: IndexingCore,
        engine: JavascriptTypescriptEngine,
        semantic_checker: Option<SemanticChecker>,
        semantic_descriptor: Option<urdira_worker_protocol::SemanticEngineDescriptor>,
        semantic_pending: Vec<urdira_indexing_core::CanonicalOwnerObservation>,
        semantic_pending_owner_keys: HashSet<(String, String)>,
        semantic_pending_rows: usize,
        semantic_pending_bytes: usize,
        semantic_group_sequence: u64,
        syntax_project_key: Option<String>,
        syntax_analysis_token: Option<String>,
    }
    let mut operations: HashMap<String, ActiveOperation> = HashMap::new();
    let mut reusable_semantic_checker: Option<ReusableSemanticChecker> = None;
    let mut syntax_state = SyntaxWorkerState::default();
    // P3-1 deliverable 1: per-workspace `Frontier`/`StoreReader` cache for
    // the v4 `WorkspaceScan` path, kept alive for this process's whole
    // lifetime (same rationale as `syntax_state` above, which v4 ALSO
    // reuses directly under its own `v4:{workspace_id}` project-key
    // namespace -- see `v4::state`'s module doc for why one
    // `SyntaxWorkerState` instance safely serves both v3 and v4 traffic).
    let mut v4_worker_state: v4::state::WorkerState = HashMap::new();
    let flush_semantic_pending = |operation: &mut ActiveOperation| {
        if operation.semantic_pending.is_empty() {
            return Ok(None);
        }
        let group = urdira_indexing_core::CanonicalPhysicalGroup {
            group_sequence: operation.semantic_group_sequence,
            owners: std::mem::take(&mut operation.semantic_pending),
        };
        let receipt = operation.core.accept_canonical_group_owned(group)?;
        operation.semantic_group_sequence = operation.semantic_group_sequence.saturating_add(1);
        operation.semantic_pending_rows = 0;
        operation.semantic_pending_bytes = 0;
        operation.semantic_pending_owner_keys.clear();
        Ok(Some(receipt))
    };
    // P1-D-c: `output` is shared (not a plain local, and NOT `io::stdout()
    // .lock()` -- a `StdoutLock` held for the process's whole life, as this
    // used to be, would deadlock a second thread's own `io::stdout().lock()`
    // attempt) so the residual-pass event pump below (a dedicated thread,
    // not this loop) can write an `IndexingEvent::UpgradeCompleted` frame
    // the MOMENT it arrives, real-time, without waiting for this loop to
    // process another command first. Every write anywhere in this process
    // -- this loop's own command responses, and the pump's residual events
    // -- goes through this SAME mutex, so two frames can never interleave.
    let output = Arc::new(Mutex::new(io::BufWriter::new(io::stdout())));
    let mut input = io::stdin().lock();
    let mut buffer = [0_u8; 64 * 1024];
    // P1-D-c seam (`v4::residual`'s own module doc, "Why this module never
    // touches `main.rs`'s command loop"): `v4::scan::run_with_residual`
    // schedules the background checker pass and, on completion, sends a
    // fully-built `(stream_id, cancellation_id, IndexingEvent)` frame
    // through this channel -- picked up by the dedicated pump thread below,
    // never by this loop directly.
    let (residual_tx, residual_rx) =
        mpsc::channel::<(u32, String, urdira_worker_protocol::IndexingEvent)>();
    {
        let output = Arc::clone(&output);
        std::thread::spawn(move || {
            while let Ok((stream_id, cancellation_id, event)) = residual_rx.recv() {
                let mut guard = match output.lock() {
                    Ok(guard) => guard,
                    Err(poisoned) => poisoned.into_inner(),
                };
                if write_event(&mut *guard, stream_id, &cancellation_id, &event).is_err() {
                    break;
                }
                let _ = guard.flush();
            }
        });
    }
    'read: loop {
        let read = input.read(&mut buffer)?;
        if read == 0 {
            break 'read;
        }
        for message in decoder.push(&buffer[..read])? {
            let command: IndexingCommand = decode_json(&message)?;
            let event = match command {
                IndexingCommand::Handshake {
                    request_id,
                    protocol_identity,
                } => {
                    if protocol_identity != INDEXING_CORE_PROTOCOL_IDENTITY {
                        IndexingEvent::Error {
                            request_id,
                            code: "core:protocol_mismatch".into(),
                            message: "The indexing-core protocol identity is unsupported.".into(),
                        }
                    } else {
                        IndexingEvent::HandshakeAck {
                            request_id,
                            protocol_identity: INDEXING_CORE_PROTOCOL_IDENTITY.into(),
                            protocol_version: CORE_PROTOCOL_VERSION,
                        }
                    }
                }
                IndexingCommand::IndexGeneration {
                    request_id,
                    mut request,
                } => {
                    SECONDARY_MAINTENANCE_EPOCH.fetch_add(1, Ordering::AcqRel);
                    // Build the core-facing generation descriptor once and
                    // share it with both the open/validation step and the
                    // engine. The previous route allocated two identical
                    // descriptors before the first source byte was read.
                    let generation_request = GenerationRequest {
                        operation_id: request.operation_id.clone(),
                        workspace_id: request.workspace_id.clone(),
                        candidate_generation_id: request.candidate_generation_id.clone(),
                        cancellation_path: request.cancellation_path.as_deref().map(PathBuf::from),
                        direct_publication: request.direct_publication,
                        source_snapshot_id: request.source_snapshot_id.clone(),
                        cas_root: request.cas_root.clone(),
                        source_state_digest: request.source_state_digest.clone(),
                        base_generation: request.base_generation,
                        registry_snapshot_id: request.registry_snapshot_id.clone(),
                        configuration_revision_id: request.configuration_revision_id.clone(),
                        resolution_lock_id: request.resolution_lock_id.clone(),
                        workspace_schema_digest: request.workspace_schema_digest.clone(),
                        change_set: request.change_set.clone(),
                        candidate: request.candidate.clone(),
                        frozen_base: request.frozen_base.clone(),
                        work_manifest: request.work_manifest.clone(),
                        engine: urdira_indexing_core::EngineDescriptor {
                            engine_id: request.engine.engine_id.clone(),
                            engine_version: request.engine.engine_version.clone(),
                            implementation_digest: request.engine.implementation_digest.clone(),
                        },
                        deadline_ms: request.deadline_ms,
                    };
                    // `open_with_lease_wait` (not the single-attempt `open`)
                    // because this is the foreground scan path: it can lose a
                    // brief race against a chunk of the now-chunked lexical
                    // maintenance pass, which releases the writer lease every
                    // few seconds (see the method's doc comment in
                    // urdira-indexing-core for the full rationale).
                    match IndexingCore::open_with_lease_wait(
                        &request.database_path,
                        &generation_request,
                    ) {
                        Ok(mut core) => {
                            let mut engine = JavascriptTypescriptEngine::new(
                                generation_request.engine.engine_version.clone(),
                                generation_request.engine.implementation_digest.clone(),
                            );
                            // `prepare` is deliberately called before the first
                            // group arrives. It verifies the closed engine
                            // descriptor and gives the worker a single place to
                            // reject a mismatched registry/configuration before
                            // any SQLite mutation occurs.
                            engine.prepare(&generation_request, &core.cancellation())?;
                            if operations.contains_key(&request.operation_id) {
                                IndexingEvent::Error {
                                    request_id: request_id.clone(),
                                    code: "core:operation_conflict".into(),
                                    message: "The indexing operation identity is already active."
                                        .into(),
                                }
                            } else {
                                // The opaque engine envelope is consumed exactly
                                // once. Keeping it in the protocol request after
                                // parsing forced a full serde_json clone before
                                // syntax analysis and duplicated the source
                                // manifest in the composition worker.
                                let engine_input = request.engine_input.take();
                                // P1-B: `URDIRA_JSTS_TYPEFLOW=1` never spawns
                                // the semantic checker lane at all, even when
                                // the caller still supplied a `semantic_
                                // engine` descriptor (the request's own
                                // field stays optional either way -- see
                                // `hybrid_owner_can_skip_checker`'s doc
                                // comment, updated alongside this). Treating
                                // the descriptor as absent here is the
                                // GLOBAL, uniform skip that doc comment's
                                // "no wired live yet" caveat was about: a
                                // per-owner selective skip would desync the
                                // checker's fixed 32-owner-per-group request
                                // stride, but skipping EVERY owner uniformly
                                // (this generation never asks the checker
                                // anything) has no such hazard.
                                //
                                // P1-C fix: this global skip must NOT apply
                                // when the oracle census
                                // (`URDIRA_JSTS_TYPEFLOW_ORACLE=1`) is also
                                // requested -- the census's entire point is
                                // comparing typeflow's own guess against the
                                // checker's INDEPENDENT answer at the same
                                // span (`census_typeflow_owner`), which needs
                                // the checker to keep running. Found live: a
                                // P1-C measurement run under `URDIRA_JSTS_
                                // TYPEFLOW=1 URDIRA_JSTS_TYPEFLOW_ORACLE=1`
                                // silently produced an EMPTY census (the
                                // checker never started, so `observations`
                                // never carried a `core:call`/`core:inherits`
                                // row to compare against) -- diagnosed via
                                // the complete absence of this generation's
                                // own `URDIRA_DEBUG_TIMING` "jsts hybrid
                                // semantics" log line, not a crash or an
                                // error, which is exactly why this needed a
                                // fix rather than a workaround: the
                                // production checker-off path (oracle NOT
                                // requested) is unaffected.
                                let semantic_descriptor =
                                    if typeflow_enabled() && !typeflow_oracle_enabled() {
                                        None
                                    } else {
                                        request.semantic_engine.clone()
                                    };
                                let mut semantic_checker = if let Some(descriptor) =
                                    semantic_descriptor.as_ref()
                                {
                                    match reusable_semantic_checker.take() {
                                        Some(reusable) if reusable.descriptor == *descriptor => {
                                            Some(reusable.checker)
                                        }
                                        Some(mut reusable) => {
                                            // A changed executable/build identity
                                            // cannot share a TypeScript snapshot;
                                            // close the old checker before
                                            // starting the verified replacement.
                                            reusable.checker.shutdown();
                                            Some(SemanticChecker::spawn(descriptor)?)
                                        }
                                        None => Some(SemanticChecker::spawn(descriptor)?),
                                    }
                                } else {
                                    None
                                };
                                // Keep the semantic receipt sequence after the
                                // syntax receipts already accepted by this
                                // combined generation. Both lanes share the
                                // generic receipt namespace; restarting at
                                // zero makes a large direct generation fail
                                // closed with a conflicting physical receipt.
                                let mut completed_semantic_groups = 0_u64;
                                let summary_result: Option<
                                    Result<JstsGenerationSummary, CoreError>,
                                > = engine_input.map(|input| {
                                    let envelope = serde_json::from_value::<
                                        JstsGenerationInputEnvelope,
                                    >(input)
                                    .map_err(|error| {
                                        CoreError(format!("JS/TS engine input is invalid: {error}"))
                                    })?;
                                    let parsed = resolve_jsts_generation_input(
                                        &mut core,
                                        &generation_request,
                                        envelope,
                                    )?;
                                    persist_candidate_lifecycle(
                                        &mut core,
                                        &generation_request,
                                        generation_request.candidate.as_ref(),
                                        generation_request.frozen_base.as_ref(),
                                        generation_request.work_manifest.as_ref(),
                                    )?;
                                    // A direct Rust generation combines the
                                    // syntax lane with the semantic checker
                                    // in one transaction. Keep stage-one
                                    // observations in that same generation;
                                    // gating them on `semantic.is_none()` used
                                    // to silently drop declarations whenever
                                    // the combined cold/incremental envelope
                                    // also carried semantic input.
                                    let summary = run_jsts_generation(
                                        &mut syntax_state,
                                        &mut core,
                                        &mut engine,
                                        &generation_request,
                                        &parsed,
                                        generation_request.direct_publication
                                            || parsed.semantic.is_none(),
                                    )?;
                                    if let (Some(checker), Some(_semantic)) =
                                        (semantic_checker.as_mut(), parsed.semantic.as_ref())
                                    {
                                        let (semantic_groups, _, _) = run_jsts_semantic_generation(
                                            checker,
                                            &mut core,
                                            &generation_request,
                                            &parsed,
                                            &summary,
                                            semantic_descriptor
                                                .as_ref()
                                                .expect("semantic descriptor present"),
                                            &syntax_state,
                                        )?;
                                        completed_semantic_groups = semantic_groups;
                                    }
                                    Ok(summary)
                                });
                                match summary_result {
                                    Some(Err(error)) => {
                                        let _ = mark_candidate_failed(
                                            &mut core,
                                            &generation_request,
                                            "core:engine_failed",
                                        );
                                        IndexingEvent::Error {
                                            request_id,
                                            code: "core:engine_failed".into(),
                                            message: error.to_string(),
                                        }
                                    }
                                    summary_result => {
                                        let summary = summary_result
                                            .transpose()
                                            .expect("summary result handled");
                                        // Keep the workspace mutation lease from
                                        // staging through final publication. The
                                        // application receives only bounded
                                        // progress metadata between these commands;
                                        // no TypeScript writer may interleave a
                                        // source or structural mutation against the
                                        // frozen base while Rust holds the TEMP
                                        // receipt ledger. Failure cleanup below
                                        // releases the lease and preserves the
                                        // receipt-backed recovery path.
                                        operations.insert(
                                            request.operation_id.clone(),
                                            ActiveOperation {
                                                request: generation_request,
                                                core,
                                                engine,
                                                semantic_checker,
                                                semantic_descriptor,
                                                semantic_pending: Vec::new(),
                                                semantic_pending_owner_keys: HashSet::new(),
                                                semantic_pending_rows: 0,
                                                semantic_pending_bytes: 0,
                                                semantic_group_sequence: summary
                                                    .as_ref()
                                                    .map(|value| {
                                                        value.group_count.saturating_add(
                                                            completed_semantic_groups,
                                                        )
                                                    })
                                                    .unwrap_or(0),
                                                syntax_project_key: summary
                                                    .as_ref()
                                                    .map(|s| s.project_key.clone()),
                                                syntax_analysis_token: summary
                                                    .as_ref()
                                                    .map(|s| s.analysis_token.clone()),
                                            },
                                        );
                                        IndexingEvent::Progress {
                                            request_id,
                                            operation_id: request.operation_id,
                                            phase: if summary.is_some() {
                                                "group_accepted".into()
                                            } else {
                                                "prepared".into()
                                            },
                                            completed_groups: summary
                                                .as_ref()
                                                .map_or(0, |s| s.group_count),
                                            completed_owners: summary
                                                .as_ref()
                                                .map_or(0, |s| s.owner_count),
                                            completed_rows: summary
                                                .as_ref()
                                                .map_or(0, |s| s.row_count),
                                            affected_paths: summary
                                                .as_ref()
                                                .map(|s| s.affected_paths.clone()),
                                            changed_paths: summary
                                                .as_ref()
                                                .map(|s| s.changed_paths.clone()),
                                            dependency_graph: summary
                                                .as_ref()
                                                .map(|s| s.dependency_graph.clone()),
                                            analysis_token: summary.map(|s| s.analysis_token),
                                        }
                                    }
                                }
                            }
                        }
                        Err(error) => IndexingEvent::Error {
                            request_id,
                            code: "core:index_open_failed".into(),
                            message: error.to_string(),
                        },
                    }
                }
                IndexingCommand::AcceptGroup {
                    request_id,
                    operation_id,
                    group,
                } => match operations.get_mut(&operation_id) {
                    Some(operation) => {
                        let ActiveOperation { core, engine, .. } = operation;
                        match serde_json::from_value::<PhysicalGroup>(group) {
                            Ok(group) => {
                                let owner_paths = group
                                    .owners
                                    .iter()
                                    .map(|owner| owner.owner_path.clone())
                                    .collect::<Vec<_>>();
                                match engine.enqueue_group(
                                    owner_paths.first().cloned().unwrap_or_default(),
                                    group,
                                ) {
                                    Ok(()) => match engine
                                        .analyze_group(&owner_paths, &core.cancellation())
                                        .and_then(|group| core.accept_engine_group_owned(group))
                                    {
                                        Ok(receipt) => IndexingEvent::Progress {
                                            request_id,
                                            operation_id,
                                            phase: "group_accepted".into(),
                                            completed_groups: receipt_value(&receipt, |r| {
                                                r.group_sequence + 1
                                            }),
                                            completed_owners: receipt_value(&receipt, |r| {
                                                r.owner_count as u64
                                            }),
                                            completed_rows: receipt_value(&receipt, |r| {
                                                r.row_count as u64
                                            }),
                                            affected_paths: None,
                                            changed_paths: None,
                                            dependency_graph: None,
                                            analysis_token: None,
                                        },
                                        Err(error) => IndexingEvent::Error {
                                            request_id,
                                            code: "core:group_rejected".into(),
                                            message: error.to_string(),
                                        },
                                    },
                                    Err(error) => IndexingEvent::Error {
                                        request_id,
                                        code: "core:group_rejected".into(),
                                        message: error.to_string(),
                                    },
                                }
                            }
                            Err(error) => IndexingEvent::Error {
                                request_id,
                                code: "core:group_invalid".into(),
                                message: error.to_string(),
                            },
                        }
                    }
                    None => IndexingEvent::Error {
                        request_id,
                        code: "core:operation_not_found".into(),
                        message: "The indexing operation is not active.".into(),
                    },
                },
                IndexingCommand::AcceptCanonicalGroup {
                    request_id,
                    operation_id,
                    group,
                } => match operations.get_mut(&operation_id) {
                    Some(ActiveOperation { core, .. }) => match serde_json::from_value::<
                        CanonicalPhysicalGroup,
                    >(group)
                    {
                        Ok(group) => match core.accept_canonical_group_owned(group) {
                            Ok(receipt) => IndexingEvent::Progress {
                                request_id,
                                operation_id,
                                phase: "group_accepted".into(),
                                completed_groups: receipt_value(&receipt, |r| r.group_sequence + 1),
                                completed_owners: receipt_value(&receipt, |r| r.owner_count as u64),
                                completed_rows: receipt_value(&receipt, |r| r.row_count as u64),
                                affected_paths: None,
                                changed_paths: None,
                                dependency_graph: None,
                                analysis_token: None,
                            },
                            Err(error) => IndexingEvent::Error {
                                request_id,
                                code: "core:group_rejected".into(),
                                message: error.to_string(),
                            },
                        },
                        Err(error) => IndexingEvent::Error {
                            request_id,
                            code: "core:group_invalid".into(),
                            message: error.to_string(),
                        },
                    },
                    None => IndexingEvent::Error {
                        request_id,
                        code: "core:operation_not_found".into(),
                        message: "The indexing operation is not active.".into(),
                    },
                },
                IndexingCommand::AnalyzeSemanticGroup {
                    request_id,
                    operation_id,
                    requests,
                } => match operations.get_mut(&operation_id) {
                    Some(operation) => {
                        let result: Result<IndexingEvent, CoreError> = (|| {
                            if operation.core.cancellation_requested() {
                                return Err(CoreError("indexing operation cancelled".into()));
                            }
                            let owned_requests =
                                requests.into_iter().map(Arc::new).collect::<Vec<_>>();
                            let owners = match operation.semantic_checker.as_mut() {
                            Some(checker) => analyze_semantic_pages(checker, &owned_requests),
                            None => Err(CoreError("The Rust semantic checker is not configured for this generation".into())),
                        }?;
                            if operation.core.cancellation_requested() {
                                return Err(CoreError("indexing operation cancelled".into()));
                            }
                            let mut last_receipt = None;
                            for owner in owners {
                                for batch in owner.batches {
                                    let owner_key = (
                                        owner.owner_artifact_id.clone(),
                                        owner.owner_artifact_version_id.clone(),
                                    );
                                    let is_new_owner =
                                        !operation.semantic_pending_owner_keys.contains(&owner_key);
                                    let batch_rows = batch.canonical_records.len()
                                        + batch.canonical_dependencies.len();
                                    let batch_bytes = batch
                                        .canonical_records
                                        .iter()
                                        .map(String::len)
                                        .sum::<usize>()
                                        + batch
                                            .canonical_dependencies
                                            .iter()
                                            .map(String::len)
                                            .sum::<usize>();
                                    if !operation.semantic_pending.is_empty()
                                        && ((is_new_owner
                                            && operation.semantic_pending_owner_keys.len()
                                                >= urdira_indexing_core::MAX_GROUP_OWNERS)
                                            || operation
                                                .semantic_pending_rows
                                                .saturating_add(batch_rows)
                                                > urdira_indexing_core::MAX_GROUP_ROWS
                                            || operation
                                                .semantic_pending_bytes
                                                .saturating_add(batch_bytes)
                                                > urdira_indexing_core::MAX_GROUP_BYTES)
                                    {
                                        last_receipt = flush_semantic_pending(operation)?;
                                    }
                                    operation.semantic_pending_owner_keys.insert(owner_key);
                                    operation.semantic_pending_rows =
                                        operation.semantic_pending_rows.saturating_add(batch_rows);
                                    operation.semantic_pending_bytes = operation
                                        .semantic_pending_bytes
                                        .saturating_add(batch_bytes);
                                    operation.semantic_pending.push(
                                        urdira_indexing_core::CanonicalOwnerObservation {
                                            owner_artifact_id: owner.owner_artifact_id.clone(),
                                            owner_artifact_version_id: owner
                                                .owner_artifact_version_id
                                                .clone(),
                                            owner_path: owner.owner_path.clone(),
                                            lane: "semantic".into(),
                                            sequence: batch.sequence,
                                            final_batch: batch.final_batch,
                                            canonical_records: batch.canonical_records,
                                            canonical_dependencies: batch.canonical_dependencies,
                                            byte_length: batch.byte_length,
                                            owner_digest: batch.owner_digest,
                                            fact_delta_id: batch.fact_delta_id,
                                            delta_digest: batch.delta_digest,
                                            diagnostic_codes: Vec::new(),
                                        },
                                    );
                                }
                            }
                            let (groups, owners_count, rows_count) = last_receipt
                                .as_ref()
                                .map(|receipt| {
                                    (
                                        receipt_value(receipt, |value| value.group_sequence + 1),
                                        receipt_value(receipt, |value| value.owner_count as u64),
                                        receipt_value(receipt, |value| value.row_count as u64),
                                    )
                                })
                                .unwrap_or((operation.semantic_group_sequence, 0, 0));
                            Ok(IndexingEvent::Progress {
                                request_id: request_id.clone(),
                                operation_id,
                                phase: "semantic_group_buffered".into(),
                                completed_groups: groups,
                                completed_owners: owners_count,
                                completed_rows: rows_count,
                                affected_paths: None,
                                changed_paths: None,
                                dependency_graph: None,
                                analysis_token: None,
                            })
                        })();
                        result.unwrap_or_else(|error| IndexingEvent::Error {
                            request_id,
                            code: "core:semantic_failed".into(),
                            message: error.to_string(),
                        })
                    }
                    None => IndexingEvent::Error {
                        request_id,
                        code: "core:operation_not_found".into(),
                        message: "The indexing operation is not active.".into(),
                    },
                },
                IndexingCommand::InvokeSemantic {
                    request_id,
                    operation_id,
                    request,
                } => match operations.get_mut(&operation_id) {
                    Some(operation) => match operation.semantic_checker.as_mut() {
                        Some(_checker) if operation.core.cancellation_requested() => {
                            IndexingEvent::Error {
                                request_id,
                                code: "core:semantic_cancelled".into(),
                                message: "indexing operation cancelled".into(),
                            }
                        }
                        Some(checker) => match checker.invoke(request) {
                            Ok(result) => IndexingEvent::SemanticResult {
                                request_id,
                                operation_id,
                                result: result.get("result").cloned().unwrap_or(result),
                            },
                            Err(error) => IndexingEvent::Error {
                                request_id,
                                code: "core:semantic_failed".into(),
                                message: error.to_string(),
                            },
                        },
                        None => IndexingEvent::Error {
                            request_id,
                            code: "core:semantic_unavailable".into(),
                            message:
                                "The Rust semantic checker is not configured for this generation"
                                    .into(),
                        },
                    },
                    None => IndexingEvent::Error {
                        request_id,
                        code: "core:operation_not_found".into(),
                        message: "The indexing operation is not active.".into(),
                    },
                },
                IndexingCommand::FinalizeGeneration {
                    request_id,
                    operation_id,
                    publication,
                } => {
                    // Keep a failed operation resident so `status`, `cancel`,
                    // or a bounded retry can recover its receipt-backed
                    // staging. Removing it before `seal`/publication made a
                    // transient SQLite lock or injected checkpoint failure
                    // irrecoverable and leaked the temporary generation.
                    let result = match operations.get_mut(&operation_id) {
                        Some(operation) => flush_semantic_pending(operation).and_then(|_| {
                            let ActiveOperation {
                                request,
                                core,
                                engine,
                                syntax_project_key,
                                syntax_analysis_token,
                                ..
                            } = operation;
                            let database_path = core.workspace_path().to_owned();
                            core.seal(request).and_then(|descriptor| {
                                let mut sink = WorkspacePublicationSink {
                                    publication: publication.clone(),
                                };
                                let publish_started = Instant::now();
                                core.publish(request, &descriptor, &mut sink)?;
                                if std::env::var_os("URDIRA_DEBUG_TIMING").is_some() {
                                    eprintln!(
                                        "[urdira-indexing-worker] rust core publish ms={}",
                                        publish_started.elapsed().as_millis()
                                    );
                                }
                                let published_generation = if publication.is_some() {
                                    core.visible_generation(&request.workspace_id)?
                                } else {
                                    i64::try_from(request.base_generation.saturating_add(1))
                                        .map_err(|_| {
                                            CoreError(
                                                "published generation exceeds SQLite range".into(),
                                            )
                                        })?
                                };
                                let published_generation_u64 = u64::try_from(published_generation)
                                    .map_err(|_| {
                                        CoreError(
                                            "published generation exceeds protocol range".into(),
                                        )
                                    })?;
                                // Lexical reconciliation is a Rust-owned
                                // post-publication phase. The application sends
                                // only the immutable CAS root and bounds; no
                                // TypeScript lexical writer is scheduled for this
                                // generation. Do not open that detached writer
                                // until this operation's SQLite connection has
                                // been dropped (see the match below); opening
                                // it here can make SQLite's journal-mode setup
                                // contend with the still-live publication
                                // connection on a large WAL.
                                let post_publication_maintenance = if let Some(lexical) =
                                    publication.as_ref().and_then(|value| value.get("lexical"))
                                {
                                    let cas_root = lexical
                                        .get("cas_root")
                                        .and_then(Value::as_str)
                                        .ok_or_else(|| {
                                            CoreError("lexical.cas_root is missing".into())
                                        })?;
                                    let max_document_bytes = lexical
                                        .get("max_document_bytes")
                                        .and_then(Value::as_u64)
                                        .unwrap_or(2_000_000)
                                        as usize;
                                    core.release_mutation_lease();
                                    let mut maintenance_request = request.clone();
                                    // The generation deadline covers source,
                                    // analysis and structural publication. A
                                    // very large cold generation can quite
                                    // legitimately cross that deadline before
                                    // detached lexical maintenance starts;
                                    // reusing the expired timestamp makes a
                                    // correct publication look failed. Give
                                    // the independent post-publication phase
                                    // its own bounded window instead.
                                    maintenance_request.deadline_ms =
                                        Some(post_publication_deadline_ms());
                                    PostPublicationMaintenance::Lexical(LexicalMaintenance {
                                        database_path: database_path.clone(),
                                        request: maintenance_request,
                                        cas_root: cas_root.to_owned(),
                                        generation: published_generation,
                                        max_document_bytes,
                                    })
                                } else {
                                    core.release_mutation_lease();
                                    PostPublicationMaintenance::WalCheckpoint {
                                        database_path: database_path.clone(),
                                        request: request.clone(),
                                    }
                                };
                                engine.acknowledge(&descriptor)?;
                                if let (Some(project_key), Some(analysis_token)) =
                                    (syntax_project_key.as_ref(), syntax_analysis_token.as_ref())
                                {
                                    match syntax_state.commit_analysis(
                                        format!("{}:commit", request.operation_id),
                                        project_key.clone(),
                                        analysis_token.clone(),
                                    ) {
                                        Ok(WorkerMessage::CommitAnalysisAck { .. }) => {}
                                        Ok(_) => {
                                            return Err(CoreError(
                                                "JS/TS syntax commit acknowledgement is invalid"
                                                    .into(),
                                            ));
                                        }
                                        Err(error) => {
                                            return Err(CoreError(format!(
                                                "JS/TS syntax commit failed: {}",
                                                error.message
                                            )));
                                        }
                                    }
                                }
                                Ok((
                                    published_generation_u64,
                                    descriptor,
                                    post_publication_maintenance,
                                ))
                            })
                        }),
                        None => Err(CoreError("The indexing operation is not active.".into())),
                    };
                    if result.is_err() {
                        // Keep receipt-backed staging available for recovery,
                        // but never strand the workspace-wide mutation lock
                        // after a failed publication checkpoint.
                        if let Some(operation) = operations.get_mut(&operation_id) {
                            operation.core.release_mutation_lease();
                        }
                    }
                    match result {
                        Ok((generation, descriptor, post_publication_maintenance)) => {
                            // Drop the active operation before opening any
                            // detached maintenance connection. Its SQLite
                            // connection owns TEMP staging tables and can
                            // otherwise keep journal-mode/BEGIN IMMEDIATE
                            // acquisition locked on macOS for a full-corpus
                            // publication.
                            if let Some(mut operation) = operations.remove(&operation_id) {
                                if let (Some(descriptor), Some(checker)) = (
                                    operation.semantic_descriptor.take(),
                                    operation.semantic_checker.take(),
                                ) {
                                    reusable_semantic_checker = Some(ReusableSemanticChecker {
                                        descriptor,
                                        checker,
                                    });
                                }
                                drop(operation);
                            }
                            match post_publication_maintenance {
                                PostPublicationMaintenance::Lexical(maintenance) => {
                                    schedule_lexical_reconcile(
                                        maintenance.database_path,
                                        maintenance.request,
                                        maintenance.cas_root,
                                        maintenance.generation,
                                        maintenance.max_document_bytes,
                                    );
                                }
                                PostPublicationMaintenance::WalCheckpoint {
                                    database_path,
                                    request,
                                } => schedule_wal_checkpoint(database_path, request),
                            }
                            IndexingEvent::Completed {
                                request_id,
                                operation_id,
                                generation,
                                group_count: descriptor.group_count as u64,
                                owner_count: descriptor.owner_count as u64,
                                row_count: descriptor.row_count as u64,
                                ordered_digest: descriptor.ordered_digest,
                                lexical_closed: None,
                                lexical_inserted: None,
                                lexical_oversized: None,
                            }
                        }
                        Err(error) => IndexingEvent::Error {
                            request_id,
                            code: if error.0 == "The indexing operation is not active." {
                                "core:operation_not_found".into()
                            } else {
                                "core:publish_failed".into()
                            },
                            message: error.to_string(),
                        },
                    }
                }
                IndexingCommand::SourceIndexCommit {
                    request_id,
                    operation_id,
                    workspace_id,
                    database_path,
                    commits,
                    finalize_state,
                } => {
                    let generation_request = GenerationRequest {
                        operation_id: operation_id.clone(),
                        workspace_id: workspace_id.clone(),
                        candidate_generation_id: operation_id.clone(),
                        cancellation_path: None,
                        direct_publication: false,
                        source_snapshot_id: format!("source-only:{operation_id}"),
                        cas_root: database_path.clone(),
                        source_state_digest: "source-only".into(),
                        base_generation: 0,
                        registry_snapshot_id: "source-only".into(),
                        configuration_revision_id: "source-only".into(),
                        resolution_lock_id: "source-only".into(),
                        workspace_schema_digest: None,
                        change_set: AuthoritativeChangeSet::Full,
                        candidate: None,
                        frozen_base: None,
                        work_manifest: None,
                        engine: urdira_indexing_core::EngineDescriptor {
                            engine_id: "urdira:source-index".into(),
                            engine_version: "1".into(),
                            implementation_digest: "source-index".into(),
                        },
                        deadline_ms: None,
                    };
                    // `open_with_lease_wait`: a generic source-catalog commit
                    // (no structural candidate) is still a foreground scan
                    // completion and races the chunked lexical maintenance
                    // pass exactly like `IndexGeneration` above.
                    match IndexingCore::open_with_lease_wait(&database_path, &generation_request)
                        .and_then(|mut core| {
                            core.with_transaction(|transaction| {
                                apply_source_index_commits(
                                    transaction,
                                    &workspace_id,
                                    Some(&Value::Array(commits.clone())),
                                    finalize_state,
                                )?;
                                if std::env::var_os("URDIRA_DEBUG_TIMING").is_some() {
                                    let artifacts: i64 = transaction
                                        .query_row("SELECT COUNT(*) FROM source_artifacts WHERE workspace_id = ?1", [&workspace_id], |row| row.get(0))
                                        .map_err(sql_error)?;
                                    let versions: i64 = transaction
                                        .query_row("SELECT COUNT(*) FROM artifact_versions WHERE workspace_id = ?1", [&workspace_id], |row| row.get(0))
                                        .map_err(sql_error)?;
                                    eprintln!("[urdira-indexing-worker] source commit rows artifacts={artifacts} versions={versions} commits={}", commits.len());
                                }
                                Ok(())
                            })
                        }) {
                        Ok(()) => IndexingEvent::SourceIndexCommitted {
                            request_id,
                            operation_id,
                            commit_count: commits.len() as u64,
                        },
                        Err(error) => IndexingEvent::Error {
                            request_id,
                            code: "core:source_index_commit_failed".into(),
                            message: error.to_string(),
                        },
                    }
                }
                IndexingCommand::SourceIndexRollback {
                    request_id,
                    operation_id,
                    workspace_id,
                    database_path,
                } => {
                    let generation_request = GenerationRequest {
                        operation_id: operation_id.clone(),
                        workspace_id: workspace_id.clone(),
                        candidate_generation_id: operation_id.clone(),
                        cancellation_path: None,
                        direct_publication: false,
                        source_snapshot_id: format!("source-rollback:{operation_id}"),
                        cas_root: database_path.clone(),
                        source_state_digest: "source-rollback".into(),
                        base_generation: 0,
                        registry_snapshot_id: "source-rollback".into(),
                        configuration_revision_id: "source-rollback".into(),
                        resolution_lock_id: "source-rollback".into(),
                        workspace_schema_digest: None,
                        change_set: AuthoritativeChangeSet::Full,
                        candidate: None,
                        frozen_base: None,
                        work_manifest: None,
                        engine: urdira_indexing_core::EngineDescriptor {
                            engine_id: "urdira:source-index".into(),
                            engine_version: "1".into(),
                            implementation_digest: "source-index".into(),
                        },
                        deadline_ms: None,
                    };
                    let result = IndexingCore::open(&database_path, &generation_request).and_then(
                        |mut core| {
                            core.with_transaction(|transaction| {
                                rollback_source_index(transaction, &workspace_id)?;
                                Ok(())
                            })
                        },
                    );
                    match result {
                        Ok(()) => IndexingEvent::SourceIndexRolledBack {
                            request_id,
                            operation_id,
                        },
                        Err(error) => IndexingEvent::Error {
                            request_id,
                            code: "core:source_index_rollback_failed".into(),
                            message: error.to_string(),
                        },
                    }
                }
                IndexingCommand::Cancel {
                    request_id,
                    operation_id,
                } => match operations.remove(&operation_id) {
                    Some(mut operation) => {
                        operation.core.cancellation().cancel();
                        let _ = operation.engine.cancel();
                        if let Some(checker) = operation.semantic_checker.as_mut() {
                            checker.shutdown();
                        }
                        IndexingEvent::Cancelled {
                            request_id,
                            operation_id,
                        }
                    }
                    None => IndexingEvent::Status {
                        request_id,
                        operation_id,
                        phase: "idle".into(),
                        active: false,
                    },
                },
                IndexingCommand::WorkspaceScan {
                    request_id,
                    workspace_id,
                    workspace_root,
                    database_path,
                    structural_root,
                    cas_root,
                    sidecar_root,
                    scope,
                    registry_snapshot_id,
                    configuration_revision_id,
                    resolution_lock_id,
                    deadline_ms,
                    priority,
                } => {
                    let stream_id = message.stream_id;
                    let cancellation_id = message.cancellation_id.clone();
                    let mut emit_queryable =
                        |queryable_event: IndexingEvent| -> Result<(), String> {
                            let mut guard = output.lock().map_err(|error| error.to_string())?;
                            write_event(&mut *guard, stream_id, &cancellation_id, &queryable_event)
                                .map_err(|error| error.to_string())?;
                            guard.flush().map_err(|error| error.to_string())
                        };
                    let scan_request = v4::scan::ScanRequest {
                        request_id: request_id.clone(),
                        workspace_id,
                        workspace_root,
                        database_path,
                        structural_root,
                        cas_root,
                        sidecar_root,
                        scope,
                        registry_snapshot_id,
                        configuration_revision_id,
                        resolution_lock_id,
                        deadline_ms,
                        priority,
                    };
                    // P1-D-c: `run_with_residual` schedules the background
                    // checker pass after a successful `ScanCompleted` (gated
                    // internally by `URDIRA_V4_RESIDUAL`, see `scan.rs`'s own
                    // doc comment) and is otherwise byte-identical to `run`
                    // for every existing caller/test -- passing a real
                    // `ResidualEventTarget` here is what lets its eventual
                    // `IndexingEvent::UpgradeCompleted` reach this SAME
                    // request's logical stream (see the channel declared
                    // above `'read:`).
                    let residual_target = Some(v4::residual::ResidualEventTarget {
                        stream_id,
                        cancellation_id: cancellation_id.clone(),
                        sender: residual_tx.clone(),
                    });
                    match v4::scan::run_with_residual(
                        scan_request,
                        &mut syntax_state,
                        &mut v4_worker_state,
                        &mut emit_queryable,
                        residual_target,
                    ) {
                        Ok(event) => event,
                        Err(error) => IndexingEvent::Error {
                            request_id,
                            code: "core:workspace_scan_failed".into(),
                            message: error.0,
                        },
                    }
                }
                IndexingCommand::Status {
                    request_id,
                    operation_id,
                } => {
                    let is_active = operations.contains_key(&operation_id);
                    IndexingEvent::Status {
                        request_id,
                        active: is_active,
                        operation_id,
                        phase: if is_active {
                            "running".into()
                        } else {
                            "idle".into()
                        },
                    }
                }
                IndexingCommand::Shutdown { request_id } => {
                    for operation in operations.values_mut() {
                        if let Some(checker) = operation.semantic_checker.as_mut() {
                            checker.shutdown();
                        }
                        let _ = operation.engine.shutdown();
                        let _ = operation.core.shutdown();
                    }
                    operations.clear();
                    if let Some(mut reusable) = reusable_semantic_checker.take() {
                        reusable.checker.shutdown();
                    }
                    let event = IndexingEvent::ShutdownAck { request_id };
                    {
                        let mut guard = output
                            .lock()
                            .unwrap_or_else(std::sync::PoisonError::into_inner);
                        write_event(
                            &mut *guard,
                            message.stream_id,
                            &message.cancellation_id,
                            &event,
                        )?;
                        guard.flush()?;
                    }
                    return Ok(());
                }
            };
            {
                let mut guard = output
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                write_event(
                    &mut *guard,
                    message.stream_id,
                    &message.cancellation_id,
                    &event,
                )?;
                guard.flush()?;
            }
        }
    }
    decoder.finish()?;
    output
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .flush()?;
    Ok(())
}
fn receipt_value(
    receipt: &urdira_indexing_core::GroupAcceptance,
    selector: impl Fn(&urdira_indexing_core::GroupReceipt) -> u64,
) -> u64 {
    match receipt {
        urdira_indexing_core::GroupAcceptance::Inserted(value)
        | urdira_indexing_core::GroupAcceptance::AlreadyAccepted(value) => selector(value),
    }
}

/// Folds every facts-lane group receipt that became ready in one
/// `FactsGroupPipeline::submit`/`finish` call into the caller's running
/// totals, in the order the pipeline returns them (already strict
/// group_sequence order).
fn fold_group_receipts(
    receipts: Vec<urdira_indexing_core::GroupAcceptance>,
    group_count: &mut u64,
    owner_count: &mut u64,
    row_count: &mut u64,
) {
    for receipt in receipts {
        *group_count = group_count.saturating_add(1);
        *owner_count = (*owner_count)
            .saturating_add(receipt_value(&receipt, |value| value.owner_count as u64));
        *row_count =
            (*row_count).saturating_add(receipt_value(&receipt, |value| value.row_count as u64));
    }
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct JstsGenerationInput {
    project_key: String,
    configuration_digest: String,
    root_names: Vec<String>,
    files: Vec<SourceInput>,
    /// Resolution-relevant workspace assets (E2, F5 hybrid design):
    /// `package.json`, `tsconfig.json`/`jsconfig.json`, `pnpm-workspace.
    /// yaml`. Their content digests are folded into the `configuration_
    /// digest` `SyntaxWorkerState::analyze` actually keys its incremental
    /// state on (inside `urdira-jsts-syntax-worker`, not here), so an edit
    /// to one of these -- even with the JS/TS source set otherwise
    /// unchanged -- still forces a full re-resolution.
    #[serde(default)]
    config_assets: Vec<ConfigAssetInput>,
    budgets: AnalysisBudgets,
    #[serde(default)]
    semantic: Option<JstsSemanticInput>,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct JstsSemanticInput {
    inputs_digest: String,
    registry_digest: String,
    plugin_id: String,
    plugin_version: String,
    analysis_digest: String,
    analysis_configuration_digest: String,
    stage_capabilities: Vec<String>,
    stage_record_kinds: Vec<String>,
    #[serde(default)]
    publication_stage_id: Option<String>,
    #[serde(default)]
    included_publication_stage_ids: Option<Vec<String>>,
    #[serde(default)]
    base_snapshot_id: Option<String>,
    created_at: String,
}

/// Wire envelope accepted from the application.  `files` and `root_names`
/// are optional on purpose: production Rust-owned generations resolve them
/// from the current source frontier through the leased core connection.  The
/// fields remain accepted for the private oracle/test transport only.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct JstsGenerationInputEnvelope {
    project_key: String,
    configuration_digest: String,
    #[serde(default)]
    root_names: Option<Vec<String>>,
    #[serde(default)]
    files: Option<Vec<SourceInput>>,
    /// See `JstsGenerationInput::config_assets`. `None` (the pre-E2 shape,
    /// and every production/DB-resolved generation) means "derive from the
    /// current source frontier, same as `files`/`root_names` do" --
    /// `resolve_jsts_generation_input` below applies the SAME
    /// production-vs-oracle rule to this field it already applies to
    /// `files`/`root_names`.
    #[serde(default)]
    config_assets: Option<Vec<ConfigAssetInput>>,
    budgets: AnalysisBudgets,
    #[serde(default)]
    semantic: Option<JstsSemanticInput>,
}

fn is_jsts_source_path(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    [
        ".ts", ".tsx", ".mts", ".cts", ".d.ts", ".d.mts", ".d.cts", ".js", ".jsx", ".mjs", ".cjs",
    ]
    .iter()
    .any(|extension| lower.ends_with(extension))
}

/// A resolution-relevant workspace asset (E2): matched by exact basename,
/// not extension -- `package.json` at any depth, `tsconfig.json`/
/// `jsconfig.json` at any depth (captures every project's own config AND
/// every `extends` target that happens to live in this workspace), and the
/// single repo-root `pnpm-workspace.yaml`. A differently-named tsconfig
/// (`tsconfig.base.json`) is deliberately NOT matched -- see `resolver.rs`'s
/// own doc comments on the corresponding scope limitation for `extends`.
fn is_config_asset_path(path: &str) -> bool {
    let basename = path.rsplit('/').next().unwrap_or(path);
    matches!(basename, "package.json" | "tsconfig.json" | "jsconfig.json")
        || path == "pnpm-workspace.yaml"
}

fn cas_blob_path(cas_root: &str, content_hash: &str) -> Result<String, CoreError> {
    let hex = content_hash
        .strip_prefix("sha256:")
        .filter(|value| value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .ok_or_else(|| {
            CoreError("source content hash is not a canonical sha256 coordinate".into())
        })?;
    Ok(PathBuf::from(cas_root)
        .join("sha256")
        .join(&hex[..2])
        .join(&hex[2..])
        .to_string_lossy()
        .into_owned())
}

fn resolve_jsts_generation_input(
    core: &mut IndexingCore,
    request: &GenerationRequest,
    envelope: JstsGenerationInputEnvelope,
) -> Result<JstsGenerationInput, CoreError> {
    let (root_names, files, config_assets) =
        match (envelope.root_names, envelope.files, envelope.config_assets) {
            (Some(root_names), Some(files), config_assets) => {
                (root_names, files, config_assets.unwrap_or_default())
            }
            (None, None, None) => {
                // Production route: TS sends no file list at all (see
                // `apps/urdira/src/index.ts`'s Rust composition-worker
                // path). One frontier read serves both the JS/TS source
                // manifest (as before E2) and, new here, the resolution
                // assets -- same source of truth, two independent filters.
                let frontier = core.current_source_artifacts(&request.workspace_id)?;
                let mut files = Vec::new();
                let mut config_assets = Vec::new();
                for artifact in frontier {
                    let blob_path = cas_blob_path(&request.cas_root, &artifact.content_hash)?;
                    if is_jsts_source_path(&artifact.path) {
                        files.push(SourceInput {
                            path: artifact.path,
                            artifact_id: artifact.artifact_id,
                            artifact_version_id: artifact.artifact_version_id,
                            content_digest: artifact.content_hash,
                            source_blob_path: blob_path,
                            byte_length: artifact.byte_length,
                        });
                    } else if is_config_asset_path(&artifact.path) {
                        config_assets.push(ConfigAssetInput {
                            path: artifact.path,
                            content_digest: artifact.content_hash,
                            source_blob_path: blob_path,
                            byte_length: artifact.byte_length,
                        });
                    }
                }
                let root_names = files.iter().map(|file| file.path.clone()).collect();
                (root_names, files, config_assets)
            }
            _ => {
                return Err(CoreError(
                    "JS/TS engine input must provide both root_names and files or neither".into(),
                ));
            }
        };
    Ok(JstsGenerationInput {
        project_key: envelope.project_key,
        configuration_digest: envelope.configuration_digest,
        root_names,
        files,
        config_assets,
        budgets: envelope.budgets,
        semantic: envelope.semantic,
    })
}

#[derive(Debug)]
struct JstsGenerationSummary {
    project_key: String,
    analysis_token: String,
    changed_paths: Vec<String>,
    affected_paths: Vec<String>,
    dependency_graph: serde_json::Value,
    group_count: u64,
    owner_count: u64,
    row_count: u64,
}

/// Upper bound on facts-lane analysis worker threads, and the bound used for
/// the work channel and the in-flight (dispatched-but-not-yet-accepted)
/// window. A handful of threads is enough to hide the single SQLite writer
/// behind CPU-bound canonicalization/digest work; more than that mostly adds
/// scheduling overhead and RSS for physical groups that can each be up to
/// `MAX_GROUP_ROWS` rows / `MAX_GROUP_BYTES` bytes.
const FACTS_GROUP_WORKER_CAP: usize = 4;
const FACTS_GROUP_CHANNEL_CAPACITY: u64 = 6;

/// Chooses the facts-lane worker count. Small incremental closures (the
/// common edit-scan case: usually one to a few owners, one physical group)
/// stay on the fully serial path so they never pay thread-pool setup cost;
/// large cold/full scans (n8n-scale runs see ~14k owners / ~230 groups) get
/// a bounded worker pool.
fn facts_group_parallelism(owner_count: usize) -> usize {
    const DEFAULT_PARALLELISM_THRESHOLD: usize = 256;
    let configured = std::env::var("URDIRA_RUST_FACTS_PARALLELISM")
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .filter(|value| (1..=FACTS_GROUP_WORKER_CAP).contains(value));
    configured.unwrap_or(if owner_count >= DEFAULT_PARALLELISM_THRESHOLD {
        std::thread::available_parallelism()
            .map_or(1, |parallelism| parallelism.get())
            .clamp(1, FACTS_GROUP_WORKER_CAP)
    } else {
        1
    })
}

/// Per-group compute step run either inline (serial path) or inside a facts
/// worker thread (parallel path): mirrors what `accept_jsts_group` used to
/// do before handing the group to `IndexingCore`, stopping just short of the
/// single-writer SQLite acceptance. `engine` is a `JavascriptTypescriptEngine`
/// -- stateful (`&mut self`) in general -- but every group here is enqueued
/// and immediately popped back out on the very same call, so no state ever
/// needs to survive across groups, let alone across threads; a dedicated
/// engine per worker thread is enough.
fn analyze_facts_group(
    engine: &mut JavascriptTypescriptEngine,
    group: PhysicalGroup,
    cancellation: &CancellationToken,
) -> Result<(PhysicalGroup, Vec<StructuralKernelResult>), CoreError> {
    let owner_paths = group
        .owners
        .iter()
        .map(|owner| owner.owner_path.clone())
        .collect::<Vec<_>>();
    engine.enqueue_group(owner_paths[0].clone(), group)?;
    let analyzed = engine.analyze_group(&owner_paths, cancellation)?;
    prepare_engine_group(analyzed)
}

type FactsGroupOutcome = Result<(PhysicalGroup, Vec<StructuralKernelResult>), CoreError>;

/// Bounded worker pool for the facts lane. `dispatch` hands one armed
/// `PhysicalGroup` to whichever worker is free and returns immediately with
/// whatever groups are now ready to accept, in strict `group_sequence`
/// order; `finish` blocks until every dispatched group has been accepted.
/// This thread (the caller of `dispatch`/`finish`) remains the only thread
/// that ever touches `IndexingCore`, so the single-writer invariant and the
/// acceptance order are both enforced here, not inside the pool.
struct FactsGroupWorkerPool {
    work_tx: Option<mpsc::SyncSender<PhysicalGroup>>,
    result_rx: mpsc::Receiver<(u64, FactsGroupOutcome)>,
    handles: Vec<std::thread::JoinHandle<()>>,
    ready: BTreeMap<u64, FactsGroupOutcome>,
    dispatched: u64,
    accepted: u64,
}

impl FactsGroupWorkerPool {
    fn spawn(
        worker_count: usize,
        engine_version: &str,
        implementation_digest: &str,
        cancellation: CancellationToken,
    ) -> Self {
        let (work_tx, work_rx) = mpsc::sync_channel::<PhysicalGroup>(
            usize::try_from(FACTS_GROUP_CHANNEL_CAPACITY).unwrap_or(usize::MAX),
        );
        let work_rx = Arc::new(Mutex::new(work_rx));
        let (result_tx, result_rx) = mpsc::channel();
        let mut handles = Vec::with_capacity(worker_count);
        for _ in 0..worker_count {
            let work_rx = Arc::clone(&work_rx);
            let result_tx = result_tx.clone();
            let engine_version = engine_version.to_owned();
            let implementation_digest = implementation_digest.to_owned();
            let cancellation = cancellation.clone();
            handles.push(std::thread::spawn(move || {
                let mut engine =
                    JavascriptTypescriptEngine::new(engine_version, implementation_digest);
                loop {
                    let received = {
                        let receiver = match work_rx.lock() {
                            Ok(receiver) => receiver,
                            Err(poisoned) => poisoned.into_inner(),
                        };
                        receiver.recv()
                    };
                    let Ok(group) = received else {
                        break;
                    };
                    let group_sequence = group.group_sequence;
                    let outcome = analyze_facts_group(&mut engine, group, &cancellation);
                    if result_tx.send((group_sequence, outcome)).is_err() {
                        break;
                    }
                }
            }));
        }
        drop(result_tx);
        Self {
            work_tx: Some(work_tx),
            result_rx,
            handles,
            ready: BTreeMap::new(),
            dispatched: 0,
            accepted: 0,
        }
    }

    fn inflight(&self) -> u64 {
        self.dispatched.saturating_sub(self.accepted)
    }

    /// Blocks for exactly one more worker result and buffers it by
    /// group_sequence. The pool's channels close only once every worker has
    /// exited (see `finish`/`Drop`), and every worker sends exactly one
    /// result per group it receives, so this only fails to produce a result
    /// if a group was lost -- a pipeline bug, not a normal outcome.
    fn recv_one(&mut self) -> Result<(), CoreError> {
        let (group_sequence, outcome) = self.result_rx.recv().map_err(|_| {
            CoreError(
                "JS/TS facts worker pool closed before producing every dispatched group".into(),
            )
        })?;
        self.ready.insert(group_sequence, outcome);
        Ok(())
    }

    /// Accepts every already-buffered result that is next in strict
    /// group_sequence order onto the single SQLite writer, stopping at the
    /// first gap or the first error (propagated to the caller, which aborts
    /// the whole generation).
    fn drain_ready(
        &mut self,
        core: &mut IndexingCore,
    ) -> Result<Vec<urdira_indexing_core::GroupAcceptance>, CoreError> {
        let mut receipts = Vec::new();
        while let Some(outcome) = self.ready.remove(&self.accepted) {
            let (group, kernels) = outcome?;
            let receipt = core.accept_prepared_group(&group, &kernels)?;
            self.accepted = self.accepted.saturating_add(1);
            receipts.push(receipt);
        }
        Ok(receipts)
    }

    fn dispatch(
        &mut self,
        group: PhysicalGroup,
        core: &mut IndexingCore,
    ) -> Result<Vec<urdira_indexing_core::GroupAcceptance>, CoreError> {
        // Bound resident memory to a small window of physical groups: if a
        // straggler group is holding up acceptance, block arming further
        // work rather than letting completed-but-not-yet-accepted groups
        // pile up behind it. Every receipt accepted while waiting for room
        // must still reach the caller -- these are real, final acceptances
        // (each one advances `IndexingCore`'s own `next_group_sequence`),
        // and the caller folds them into the generation summary's
        // `group_count`, which the semantic lane then uses as the first
        // free `group_sequence` for its own groups. Dropping any of them
        // here previously desynchronized that continuation and produced a
        // "conflicting physical group receipt" once the semantic lane
        // reused an already-accepted sequence number.
        let mut receipts = Vec::new();
        while self.inflight() >= FACTS_GROUP_CHANNEL_CAPACITY {
            self.recv_one()?;
            receipts.extend(self.drain_ready(core)?);
        }
        let sender = self
            .work_tx
            .as_ref()
            .expect("facts worker pool sender is live while dispatching");
        sender
            .send(group)
            .map_err(|_| CoreError("JS/TS facts worker pool exited unexpectedly".into()))?;
        self.dispatched = self.dispatched.saturating_add(1);
        receipts.extend(self.drain_ready(core)?);
        Ok(receipts)
    }

    fn finish(
        mut self,
        core: &mut IndexingCore,
    ) -> Result<Vec<urdira_indexing_core::GroupAcceptance>, CoreError> {
        // Dropping the sender lets every worker's blocked `recv()` observe
        // channel closure once the queue drains, which is how they know to
        // stop pulling more work.
        self.work_tx.take();
        let mut receipts = Vec::new();
        while self.accepted < self.dispatched {
            self.recv_one()?;
            receipts.extend(self.drain_ready(core)?);
        }
        for handle in self.handles.drain(..) {
            handle
                .join()
                .map_err(|_| CoreError("JS/TS facts worker thread panicked".into()))?;
        }
        Ok(receipts)
    }
}

impl Drop for FactsGroupWorkerPool {
    fn drop(&mut self) {
        // Guarantees a clean abort on every path, including an error
        // returned from `dispatch`/`drain_ready` before `finish` ever runs:
        // closing the sender lets every worker observe channel closure and
        // exit, and joining here drains those threads before this pool
        // (and, transitively, the generation that owns it) finishes
        // unwinding. Worker panics are already surfaced by `finish`'s own
        // `join`; a panic observed only here has no result to propagate.
        self.work_tx.take();
        for handle in self.handles.drain(..) {
            let _ = handle.join();
        }
    }
}

/// Pipeline used by the facts/stage-1 lane to overlap per-group
/// canonicalization and digest computation across a bounded worker pool
/// while this thread stays the sole SQLite writer and the sole place
/// group_sequence order is enforced. With `parallelism <= 1` it degrades to
/// exactly the previous fully-serial, single-thread behavior.
struct FactsGroupPipeline {
    group_sequence: u64,
    workers: Option<FactsGroupWorkerPool>,
}

impl FactsGroupPipeline {
    fn new(
        parallelism: usize,
        engine_version: &str,
        implementation_digest: &str,
        cancellation: CancellationToken,
    ) -> Self {
        let workers = (parallelism > 1).then(|| {
            FactsGroupWorkerPool::spawn(
                parallelism,
                engine_version,
                implementation_digest,
                cancellation,
            )
        });
        Self {
            group_sequence: 0,
            workers,
        }
    }

    /// Consumes `observations` (mirrors the previous `accept_jsts_group`
    /// contract, including the empty-group no-op) and returns every group
    /// receipt that became ready to fold into the caller's running totals as
    /// a result of this call.
    fn submit(
        &mut self,
        engine: &mut JavascriptTypescriptEngine,
        core: &mut IndexingCore,
        observations: &mut Vec<urdira_indexing_core::OwnerObservation>,
    ) -> Result<Vec<urdira_indexing_core::GroupAcceptance>, CoreError> {
        if observations.is_empty() {
            return Ok(Vec::new());
        }
        let group = PhysicalGroup {
            group_sequence: self.group_sequence,
            owners: std::mem::take(observations),
        };
        self.group_sequence = self.group_sequence.saturating_add(1);
        match &mut self.workers {
            None => {
                let (group, kernels) = analyze_facts_group(engine, group, &core.cancellation())?;
                let receipt = core.accept_prepared_group(&group, &kernels)?;
                Ok(vec![receipt])
            }
            Some(pool) => pool.dispatch(group, core),
        }
    }

    /// Drains and accepts every group still in flight, in order, and joins
    /// the worker pool (a no-op on the serial path).
    fn finish(
        self,
        core: &mut IndexingCore,
    ) -> Result<Vec<urdira_indexing_core::GroupAcceptance>, CoreError> {
        match self.workers {
            None => Ok(Vec::new()),
            Some(pool) => pool.finish(core),
        }
    }
}

/// Persists candidate identity and the pure work manifest on the same Rust
/// writer that owns structural staging. This is deliberately generic: a
/// language engine supplies opaque candidate/control metadata, while the core
/// remains the only production owner of candidate rows and receipts.
fn persist_candidate_lifecycle(
    core: &mut IndexingCore,
    request: &GenerationRequest,
    candidate: Option<&Value>,
    frozen: Option<&Value>,
    work_manifest: Option<&Value>,
) -> Result<(), CoreError> {
    let Some(candidate) = candidate else {
        return Ok(());
    };
    let candidate_id = value_string(candidate, "candidate_generation_id")?;
    let workspace_id = value_string(candidate, "workspace_id")?;
    if candidate_id != request.candidate_generation_id || workspace_id != request.workspace_id {
        return Err(CoreError(
            "candidate lifecycle coordinates do not match generation".into(),
        ));
    }
    let frozen = frozen.ok_or_else(|| CoreError("candidate frozen base is missing".into()))?;
    let issue_ids = candidate
        .get("issue_ids")
        .cloned()
        .unwrap_or_else(|| Value::Array(Vec::new()));
    let source_batches = candidate
        .get("source_observation_batch_ids")
        .cloned()
        .unwrap_or_else(|| Value::Array(Vec::new()));
    let work_manifest_id = candidate
        .get("work_manifest_id")
        .and_then(Value::as_str)
        .or_else(|| {
            work_manifest
                .and_then(|m| m.get("work_manifest_id"))
                .and_then(Value::as_str)
        });
    let created_at = value_string(candidate, "created_at")?;
    core.with_transaction(|transaction| {
        transaction
            .execute(
                "INSERT OR IGNORE INTO candidate_state (candidate_generation_id, workspace_id, base_snapshot_id, base_generation, base_registry_snapshot_id, target_registry_snapshot_id, base_configuration_revision_id, target_configuration_revision_id, trigger_kind, state, work_manifest_id, source_observation_batch_ids, retention_lease_id, candidate_materialization_id, candidate_digest, created_at, analysis_started_at, ready_at, finished_at, published_snapshot_id, published_generation, generation_manifest_id, stale_against_snapshot_id, failure_code, issue_ids, frozen_snapshot_id, frozen_generation, frozen_registry_snapshot_id, frozen_resolution_lock_id, frozen_configuration_revision_id, frozen_source_state_digest, frozen_source_observation_batch_ids, frozen_tuple_digest) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'analyzing', ?10, ?11, ?12, ?13, ?14, ?15, ?16, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25)",
                params![
                    &candidate_id,
                    &workspace_id,
                    value_optional_string(candidate, "base_snapshot_id"),
                    candidate.get("base_generation").and_then(Value::as_i64),
                    value_optional_string(candidate, "base_registry_snapshot_id"),
                    value_string(candidate, "target_registry_snapshot_id")?,
                    value_optional_string(candidate, "base_configuration_revision_id"),
                    value_string(candidate, "target_configuration_revision_id")?,
                    value_string(candidate, "trigger_kind")?,
                    work_manifest_id,
                    json_text(&source_batches),
                    value_optional_string(candidate, "retention_lease_id"),
                    value_optional_string(candidate, "candidate_materialization_id"),
                    value_optional_string(candidate, "candidate_digest"),
                    &created_at,
                    value_optional_string(candidate, "analysis_started_at"),
                    json_text(&issue_ids),
                    value_optional_string(frozen, "snapshot_id"),
                    frozen.get("generation").and_then(Value::as_i64),
                    value_optional_string(frozen, "registry_snapshot_id"),
                    value_optional_string(frozen, "resolution_lock_id"),
                    value_optional_string(frozen, "configuration_revision_id"),
                    value_string(frozen, "source_state_digest")?,
                    json_text(frozen.get("source_observation_batch_ids").unwrap_or(&Value::Array(Vec::new()))),
                    value_string(frozen, "tuple_digest")?,
                ],
            )
            .map_err(sql_error)?;
        if let Some(manifest) = work_manifest {
            let manifest_id = value_string(manifest, "work_manifest_id")?;
            if Some(manifest_id.as_str()) != work_manifest_id {
                return Err(CoreError("candidate work manifest identity does not match candidate".into()));
            }
            transaction
                .execute(
                    "INSERT OR IGNORE INTO candidate_work_manifests (work_manifest_id, workspace_id, candidate_generation_id, supersedes_work_manifest_id, base_snapshot_id, invalidation_plan_id, target_registry_snapshot_id, target_configuration_revision_id, artifact_work_set, projection_work_set, created_at, work_digest) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
                    params![
                        &manifest_id,
                        &workspace_id,
                        &candidate_id,
                        value_optional_string(manifest, "supersedes_work_manifest_id"),
                        value_optional_string(manifest, "base_snapshot_id"),
                        value_string(manifest, "invalidation_plan_id")?,
                        value_string(manifest, "target_registry_snapshot_id")?,
                        value_string(manifest, "target_configuration_revision_id")?,
                        json_text(manifest.get("artifact_work_set").unwrap_or(&Value::Array(Vec::new()))),
                        json_text(manifest.get("projection_work_set").unwrap_or(&Value::Array(Vec::new()))),
                        value_string(manifest, "created_at")?,
                        value_string(manifest, "work_digest")?,
                    ],
                )
                .map_err(sql_error)?;
        }
        Ok(())
    })
}

fn mark_candidate_failed(
    core: &mut IndexingCore,
    request: &GenerationRequest,
    code: &str,
) -> Result<(), CoreError> {
    core.with_transaction(|transaction| {
        transaction
            .execute(
                "UPDATE candidate_state SET state = 'failed', failure_code = ?1, finished_at = ?2 WHERE workspace_id = ?3 AND candidate_generation_id = ?4 AND state NOT IN ('published', 'stale', 'cleaned')",
                params![code, &request.operation_id, &request.workspace_id, &request.candidate_generation_id],
            )
            .map_err(sql_error)?;
        Ok(())
    })
}

/// Runs the JS/TS syntax engine inside the composition worker. The host sends
/// one opaque engine input; no owner loop, syntax page or structural row is
/// returned to the application process. This is deliberately implemented on
/// top of the generic `LanguageEngine`/`IndexingCore` seams so another
/// language can reuse the same SQLite receipt and publication machinery.
fn run_jsts_generation(
    syntax: &mut SyntaxWorkerState,
    core: &mut IndexingCore,
    engine: &mut JavascriptTypescriptEngine,
    request: &GenerationRequest,
    input: &JstsGenerationInput,
    emit_stage_one: bool,
) -> Result<JstsGenerationSummary, CoreError> {
    let cancellation = core.cancellation();
    let cancelled = cancellation.atomic();
    let syntax_started = Instant::now();
    // In-process caller (Rust -> Rust, no IPC frame): the envelope's
    // `budgets` comes straight from TS and never sets `enforce_output_
    // bytes` (the TS side has no reason to know about it), so the override
    // happens here rather than in TS -- skip the serialize-and-measure pass
    // `analyze` would otherwise run just to compare against `max_output_
    // bytes` (plan 3.1). Only the stdio binary's IPC path needs the guard.
    let budgets = AnalysisBudgets {
        enforce_output_bytes: false,
        ..input.budgets
    };
    let analysis = syntax
        .analyze(
            format!("{}:syntax", request.operation_id),
            format!("{}:syntax", request.operation_id),
            input.project_key.clone(),
            input.configuration_digest.clone(),
            input.root_names.clone(),
            input.files.clone(),
            input.config_assets.clone(),
            request.change_set.clone(),
            budgets,
            &cancelled,
        )
        .map_err(|error| CoreError(format!("JS/TS syntax analysis failed: {}", error.message)))?;
    let (analysis_token, changed_paths, affected_paths) = match analysis {
        WorkerMessage::AnalysisResult {
            analysis_token,
            changed_files,
            affected_files,
            ..
        } => (analysis_token, changed_files, affected_files),
        WorkerMessage::Cancelled { .. } => {
            return Err(CoreError("JS/TS syntax analysis cancelled".into()));
        }
        _ => {
            return Err(CoreError(
                "JS/TS syntax worker returned an invalid analysis result".into(),
            ));
        }
    };
    if std::env::var_os("URDIRA_DEBUG_TIMING").is_some() {
        eprintln!(
            "[urdira-indexing-worker] jsts syntax analysis owners={} elapsed_ms={}",
            affected_paths.len(),
            syntax_started.elapsed().as_millis()
        );
    }
    let files_by_path = input
        .files
        .iter()
        .map(|file| (file.path.clone(), file))
        .collect::<HashMap<_, _>>();
    // Semantic stages use the syntax analysis only to determine the exact
    // affected owner set. Their structural rows come from the checker below,
    // so reading every Oxc fact page here would parse/materialize the same
    // source twice without contributing a row to the requested stage.
    if !emit_stage_one {
        return Ok(JstsGenerationSummary {
            project_key: input.project_key.clone(),
            analysis_token,
            changed_paths,
            affected_paths,
            dependency_graph: serde_json::json!({}),
            group_count: 0,
            owner_count: 0,
            row_count: 0,
        });
    }
    // Keep only one physical group resident. The previous implementation
    // accumulated every owner's fact pages before grouping, which recreated
    // the V8-sized working set the Rust cutover is meant to remove.
    let mut observations = Vec::with_capacity(64);
    let mut group_count = 0_u64;
    let mut owner_count = 0_u64;
    let mut row_count = 0_u64;
    let mut group_rows = 0_usize;
    let mut group_bytes = 0_usize;
    let mut dependency_graph = BTreeMap::<String, serde_json::Value>::new();
    let mut direct_files_by_path = HashMap::<String, BTreeMap<String, ()>>::new();
    let mut imports_complete_by_path = HashMap::<String, bool>::new();
    let mut next_sequence_by_path = HashMap::<String, u64>::new();
    let mut pending = affected_paths
        .iter()
        .cloned()
        .map(|path| (path, None))
        .collect::<VecDeque<(String, Option<FactsCursor>)>>();
    let mut group_request_sequence = 0_u64;
    let facts_started = Instant::now();
    // Arming a group (reading its fact pages off `syntax`, which owns the
    // single `pending` cursor) stays on this thread; the CPU-bound
    // canonicalization/digest pass that used to run inline right after can
    // overlap with a bounded worker pool while this thread remains the only
    // SQLite writer and the only place group_sequence order is enforced.
    let mut facts_pipeline = FactsGroupPipeline::new(
        facts_group_parallelism(affected_paths.len()),
        &request.engine.engine_version,
        &request.engine.implementation_digest,
        cancellation.clone(),
    );
    while !pending.is_empty() {
        if core.cancellation_requested() {
            return Err(CoreError("JS/TS syntax analysis cancelled".into()));
        }
        let mut entries = Vec::with_capacity(64);
        while entries.len() < 64 {
            let Some((path, cursor)) = pending.pop_front() else {
                break;
            };
            entries.push((path, cursor));
        }
        let request_entries = entries
            .iter()
            .map(|(path, cursor)| FactsGroupEntry {
                path: path.clone(),
                cursor: *cursor,
            })
            .collect::<Vec<_>>();
        let response = syntax
            .read_facts_group(
                bounded_protocol_identifier(format!(
                    "{}:facts-group:{}",
                    request.operation_id, group_request_sequence
                )),
                bounded_protocol_identifier(format!("{}:facts", request.operation_id)),
                input.project_key.clone(),
                request_entries,
                16 * 1024 * 1024,
                4_096,
            )
            .map_err(|error| {
                CoreError(format!(
                    "JS/TS fact group extraction failed: {}",
                    error.message
                ))
            })?;
        group_request_sequence = group_request_sequence.saturating_add(1);
        let (pages, next_request_index) = match response {
            WorkerMessage::FactsGroupResult {
                pages,
                next_request_index,
                ..
            } => (pages, next_request_index),
            WorkerMessage::Cancelled { .. } => {
                return Err(CoreError("JS/TS fact extraction cancelled".into()));
            }
            _ => {
                return Err(CoreError(
                    "JS/TS syntax worker returned an invalid fact group".into(),
                ));
            }
        };
        for page in pages {
            let (
                path,
                parsed,
                diagnostics,
                direct_imports,
                records,
                dependencies,
                next_cursor,
                metrics,
                _source_byte_length,
            ) = match page {
                WorkerMessage::FactsResult {
                    path,
                    parsed,
                    diagnostics,
                    direct_imports,
                    records,
                    dependencies,
                    next_cursor,
                    byte_length,
                    metrics,
                    ..
                } => (
                    path,
                    parsed,
                    diagnostics,
                    direct_imports,
                    records,
                    dependencies,
                    next_cursor,
                    metrics,
                    byte_length,
                ),
                WorkerMessage::Cancelled { .. } => {
                    return Err(CoreError("JS/TS fact extraction cancelled".into()));
                }
                _ => {
                    return Err(CoreError(
                        "JS/TS syntax worker returned an invalid fact page".into(),
                    ));
                }
            };
            if !parsed || !diagnostics.is_empty() {
                return Err(CoreError(format!("JS/TS facts are incomplete for {path}")));
            }
            let file = files_by_path.get(&path).ok_or_else(|| {
                CoreError(format!(
                    "JS/TS affected path is outside the source manifest: {path}"
                ))
            })?;
            let direct_files = direct_files_by_path.entry(path.clone()).or_default();
            let imports_complete = imports_complete_by_path.entry(path.clone()).or_insert(true);
            for import in &direct_imports {
                if let Some(target) = &import.target_path {
                    direct_files.insert(target.clone(), ());
                } else if import.specifier.starts_with('.') {
                    *imports_complete = false;
                }
            }
            // Both crates expose the same closed field set with different
            // ownership/width choices. Move those fields directly instead of
            // round-tripping every row through serde_json at this boundary.
            let structural_records = records
                .into_iter()
                .map(|record| urdira_indexing_core::StructuralKernelRecord {
                    proposal_record_key: record.proposal_record_key,
                    category: record.category.to_owned(),
                    kind: record.kind,
                    universal_kind: record.universal_kind,
                    facets: record.facets,
                    schema_version: u32::from(record.schema_version),
                    source_span: record.source_span,
                    identity_key: record.identity_key,
                    // A3b: `record.body` (`ProposedRecord`) is `RecordBody`;
                    // `StructuralKernelRecord::body` is still a plain
                    // `Value` -- decode on demand rather than move directly.
                    body: record.body.to_value(),
                    evidence_references: record.evidence_references,
                })
                .collect::<Vec<_>>();
            let structural_dependencies = dependencies
                .into_iter()
                .map(
                    |dependency| urdira_indexing_core::StructuralKernelDependency {
                        proposed_dependency_id: dependency.proposed_dependency_id,
                        proposal_record_key: dependency.proposal_record_key,
                        dependency_artifact_id: dependency.dependency_artifact_id,
                        dependency_artifact_version_id: dependency.dependency_artifact_version_id,
                        dependency_role: dependency.dependency_role.to_owned(),
                        dependency_basis: dependency.dependency_basis.to_owned(),
                        source_reference: dependency.source_reference,
                    },
                )
                .collect::<Vec<_>>();
            let sequence = next_sequence_by_path.entry(path.clone()).or_default();
            let current_sequence = *sequence;
            *sequence = sequence.saturating_add(1);
            let final_batch = next_cursor.is_none();
            if emit_stage_one {
                let page_rows = structural_records
                    .len()
                    .saturating_add(structural_dependencies.len());
                // The syntax boundary already measured the serialized page
                // while enforcing its 16 MiB group budget. Reuse that metric
                // instead of serializing the converted rows a second time
                // solely to estimate physical-group size.
                let page_bytes = usize::try_from(metrics.bytes_transferred).unwrap_or(usize::MAX);
                if !observations.is_empty()
                    && (observations.len() >= urdira_indexing_core::MAX_GROUP_OWNERS
                        || group_rows.saturating_add(page_rows)
                            > urdira_indexing_core::MAX_GROUP_ROWS
                        || group_bytes.saturating_add(page_bytes)
                            > urdira_indexing_core::MAX_GROUP_BYTES)
                {
                    let receipts = facts_pipeline.submit(engine, core, &mut observations)?;
                    fold_group_receipts(
                        receipts,
                        &mut group_count,
                        &mut owner_count,
                        &mut row_count,
                    );
                    group_rows = 0;
                    group_bytes = 0;
                }
                observations.push(urdira_indexing_core::OwnerObservation {
                    owner_artifact_id: file.artifact_id.clone(),
                    owner_artifact_version_id: file.artifact_version_id.clone(),
                    owner_path: file.path.clone(),
                    lane: "syntax".into(),
                    sequence: current_sequence,
                    final_batch,
                    records: structural_records,
                    dependencies: structural_dependencies,
                    byte_length: 0,
                    owner_digest: String::new(),
                    fact_delta_id: Some(format!(
                        "jsts:delta:{}:{}:{}",
                        request.candidate_generation_id, file.artifact_id, current_sequence
                    )),
                    delta_digest: None,
                });
                group_rows = group_rows.saturating_add(page_rows);
                group_bytes = group_bytes.saturating_add(page_bytes);
            }
            if let Some(cursor) = next_cursor {
                pending.push_back((path.clone(), Some(cursor)));
            } else {
                let direct_files = direct_files_by_path.remove(&path).unwrap_or_default();
                let imports_complete = imports_complete_by_path.remove(&path).unwrap_or(true);
                dependency_graph.insert(
                    path,
                    serde_json::json!({
                        "direct_files": direct_files.keys().cloned().collect::<Vec<_>>(),
                        "complete": imports_complete,
                    }),
                );
            }
        }
        // The syntax worker may stop before all requested owners when the
        // aggregate row/byte budget is reached. Requeue those owners ahead of
        // later cursor pages without consuming their cursors.
        let consumed = next_request_index
            .unwrap_or(entries.len())
            .min(entries.len());
        for entry in entries.into_iter().skip(consumed).rev() {
            pending.push_front(entry);
        }
    }
    if emit_stage_one {
        let receipts = facts_pipeline.submit(engine, core, &mut observations)?;
        fold_group_receipts(receipts, &mut group_count, &mut owner_count, &mut row_count);
        let receipts = facts_pipeline.finish(core)?;
        fold_group_receipts(receipts, &mut group_count, &mut owner_count, &mut row_count);
    }
    if std::env::var_os("URDIRA_DEBUG_TIMING").is_some() {
        eprintln!(
            "[urdira-indexing-worker] jsts facts extraction owners={} groups={} elapsed_ms={}",
            affected_paths.len(),
            group_count,
            facts_started.elapsed().as_millis()
        );
    }
    Ok(JstsGenerationSummary {
        project_key: input.project_key.clone(),
        analysis_token,
        changed_paths,
        affected_paths,
        dependency_graph: serde_json::to_value(dependency_graph)
            .unwrap_or_else(|_| serde_json::json!({})),
        group_count,
        owner_count,
        row_count,
    })
}

fn canonical_json(value: &Value) -> String {
    match value {
        Value::Null => "null".into(),
        Value::Bool(v) => v.to_string(),
        Value::Number(v) => v.to_string(),
        Value::String(v) => serde_json::to_string(v).unwrap_or_else(|_| "\"\"".into()),
        Value::Array(values) => format!(
            "[{}]",
            values
                .iter()
                .map(canonical_json)
                .collect::<Vec<_>>()
                .join(",")
        ),
        Value::Object(map) => {
            let mut keys = map.keys().collect::<Vec<_>>();
            keys.sort_by(|left, right| {
                left.as_bytes()
                    .cmp(right.as_bytes())
                    .then_with(|| left.cmp(right))
            });
            format!(
                "{{{}}}",
                keys.into_iter()
                    .map(|key| format!(
                        "{}:{}",
                        serde_json::to_string(key).unwrap(),
                        canonical_json(&map[key])
                    ))
                    .collect::<Vec<_>>()
                    .join(",")
            )
        }
    }
}

fn canonical_sha256(value: &Value) -> String {
    let mut digest = Sha256::new();
    digest.update(canonical_json(value).as_bytes());
    let bytes = digest.finalize();
    let mut encoded = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        use std::fmt::Write as _;
        let _ = write!(&mut encoded, "{byte:02x}");
    }
    format!("sha256:{encoded}")
}

/// Hashes a canonical JSON array without first materializing the complete
/// array string. The semantic request builder keeps the same manifest entries
/// for publication, so cloning them solely to calculate `inputs_digest` would
/// duplicate a potentially large owner closure in memory.
fn canonical_sha256_array(values: &[Value]) -> String {
    let mut digest = Sha256::new();
    digest.update(b"[");
    for (index, value) in values.iter().enumerate() {
        if index > 0 {
            digest.update(b",");
        }
        digest.update(canonical_json(value).as_bytes());
    }
    digest.update(b"]");
    let bytes = digest.finalize();
    let mut encoded = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        use std::fmt::Write as _;
        let _ = write!(&mut encoded, "{byte:02x}");
    }
    format!("sha256:{encoded}")
}

fn sorted_unique_strings(values: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut values = values.into_iter().collect::<Vec<_>>();
    values.sort();
    values.dedup();
    values
}

/// Recreates the closed FactDelta@2 commitment from the canonical rows and
/// the Rust-built semantic request. This keeps owner identities, completeness
/// claims and digest bytes in the generic Rust boundary; the checker never
/// constructs a stream header on the production route.
fn rust_semantic_delta_digest(
    payload: &Value,
    observations: &[urdira_indexing_core::CanonicalOwnerObservation],
    diagnostic_proposal_keys: &[String],
) -> Result<String, CoreError> {
    let object = payload
        .as_object()
        .ok_or_else(|| CoreError("semantic payload is not an object".into()))?;
    let work_item = object
        .get("work_item")
        .and_then(Value::as_object)
        .ok_or_else(|| CoreError("semantic work item is missing".into()))?;
    let manifest = object
        .get("accepted_manifest")
        .and_then(Value::as_object)
        .ok_or_else(|| CoreError("semantic accepted manifest is missing".into()))?;
    let required = |container: &serde_json::Map<String, Value>, key: &str| {
        container
            .get(key)
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
            .ok_or_else(|| CoreError(format!("semantic digest field {key} is missing")))
    };
    let work_item_id = required(work_item, "work_item_id")?;
    let candidate_generation_id = required(work_item, "candidate_generation_id")?;
    let workspace_id = required(work_item, "workspace_id")?;
    let plugin_id = required(work_item, "plugin_id")?;
    let plugin_version = required(work_item, "plugin_version")?;
    let owner_artifact_id = required(work_item, "artifact_id")?;
    let owner_artifact_version_id = required(work_item, "target_artifact_version_id")?;
    let analysis_digest = required(object, "analysis_digest")?;
    let analysis_configuration_digest = required(object, "analysis_configuration_digest")?;
    let analysis_input_digest = required(object, "analysis_input_digest")?;
    let manifest_id = required(manifest, "plugin_input_access_manifest_id")?;
    let manifest_digest = required(manifest, "manifest_digest")?;
    let scopes = work_item
        .get("expected_replacement_scopes")
        .cloned()
        .filter(|value| value.as_array().is_some_and(|values| !values.is_empty()))
        .ok_or_else(|| CoreError("semantic replacement scopes are missing".into()))?;
    let input_versions = manifest
        .get("artifact_version_entries")
        .and_then(Value::as_array)
        .ok_or_else(|| CoreError("semantic artifact version entries are missing".into()))?
        .iter()
        .filter_map(|entry| {
            entry
                .get("artifact_version_id")
                .and_then(Value::as_str)
                .map(str::to_owned)
        });
    let input_artifact_version_ids = sorted_unique_strings(input_versions);
    let input_records = manifest
        .get("record_entries")
        .and_then(Value::as_array)
        .ok_or_else(|| CoreError("semantic record entries are missing".into()))?
        .iter()
        .filter(|entry| entry.get("input_type").and_then(Value::as_str) == Some("base_record"))
        .filter_map(|entry| {
            entry
                .get("record_id")
                .and_then(Value::as_str)
                .map(str::to_owned)
        });
    let input_record_ids = sorted_unique_strings(input_records);
    // The checker includes diagnostic proposal keys in the compact owner
    // envelope. Rust already owns the canonical row bytes and should not
    // parse every diagnostic row a second time merely to rebuild this digest
    // field; the supplied keys are sorted/deduplicated below exactly as the
    // former row scan was.
    let diagnostic_keys = sorted_unique_strings(diagnostic_proposal_keys.iter().cloned());
    let reason_codes = sorted_unique_strings(
        observations
            .iter()
            .flat_map(|observation| observation.diagnostic_codes.iter().cloned()),
    );
    let canonical_array = |values: &[String]| {
        canonical_json(&Value::Array(
            values.iter().cloned().map(Value::String).collect(),
        ))
    };
    let completeness_claims = scopes
        .as_array()
        .expect("validated replacement scopes array")
        .iter()
        .enumerate()
        .map(|(index, scope)| {
            let scope_object = scope
                .as_object()
                .ok_or_else(|| CoreError("semantic replacement scope is invalid".into()))?;
            let capability = required(scope_object, "capability")?;
            let replacement_scope_id = required(scope_object, "replacement_scope_id")?;
            let mut claim = serde_json::Map::new();
            claim.insert(
                "completeness_claim_id".into(),
                Value::String(format!("jsts:completeness:{work_item_id}:{index}")),
            );
            claim.insert("capability".into(), Value::String(capability));
            claim.insert(
                "replacement_scope_ids".into(),
                Value::String(replacement_scope_id),
            );
            claim.insert(
                "status".into(),
                Value::String(
                    if reason_codes.is_empty() {
                        "complete"
                    } else {
                        "partial"
                    }
                    .into(),
                ),
            );
            claim.insert(
                "reason_codes".into(),
                Value::String(canonical_array(&reason_codes)),
            );
            claim.insert(
                "affected_artifact_ids".into(),
                Value::String(canonical_array(if reason_codes.is_empty() {
                    &[]
                } else {
                    std::slice::from_ref(&owner_artifact_id)
                })),
            );
            claim.insert(
                "diagnostic_proposal_keys".into(),
                Value::String(canonical_array(&diagnostic_keys)),
            );
            Ok(Value::Object(claim))
        })
        .collect::<Result<Vec<_>, CoreError>>()?;
    let mut core = serde_json::Map::new();
    core.insert(
        "candidate_generation_id".into(),
        Value::String(candidate_generation_id),
    );
    core.insert("workspace_id".into(), Value::String(workspace_id));
    if let Some(value) = work_item
        .get("base_snapshot_id")
        .filter(|value| value.as_str().is_some())
    {
        core.insert("base_snapshot_id".into(), value.clone());
    }
    core.insert("work_item_id".into(), Value::String(work_item_id));
    core.insert("plugin_id".into(), Value::String(plugin_id));
    core.insert("plugin_version".into(), Value::String(plugin_version));
    core.insert("analysis_digest".into(), Value::String(analysis_digest));
    core.insert(
        "analysis_configuration_digest".into(),
        Value::String(analysis_configuration_digest),
    );
    if let Some(value) = object
        .get("publication_stage_id")
        .filter(|value| value.as_str().is_some())
    {
        core.insert("publication_stage_id".into(), value.clone());
    }
    core.insert("owner_artifact_id".into(), Value::String(owner_artifact_id));
    core.insert(
        "owner_artifact_version_id".into(),
        Value::String(owner_artifact_version_id),
    );
    core.insert("replacement_scopes".into(), scopes);
    core.insert(
        "input_artifact_version_ids".into(),
        Value::Array(
            input_artifact_version_ids
                .into_iter()
                .map(Value::String)
                .collect(),
        ),
    );
    core.insert(
        "input_record_ids".into(),
        Value::Array(input_record_ids.into_iter().map(Value::String).collect()),
    );
    core.insert(
        "plugin_input_access_manifest_id".into(),
        Value::String(manifest_id),
    );
    core.insert(
        "plugin_input_access_manifest_digest".into(),
        Value::String(manifest_digest),
    );
    core.insert(
        "analysis_input_digest".into(),
        Value::String(analysis_input_digest),
    );
    core.insert(
        "completeness_claims".into(),
        Value::Array(completeness_claims),
    );
    let mut keys = core.keys().cloned().collect::<Vec<_>>();
    keys.extend(["proposed_records".into(), "proposed_dependencies".into()]);
    keys.sort();
    let mut digest = Sha256::new();
    digest.update(b"{");
    for (index, key) in keys.iter().enumerate() {
        if index > 0 {
            digest.update(b",");
        }
        let key_json = canonical_json(&Value::String(key.clone()));
        digest.update(key_json.as_bytes());
        digest.update(b":");
        match key.as_str() {
            "proposed_records" => {
                digest.update(b"[");
                for (row_index, row) in observations
                    .iter()
                    .flat_map(|observation| observation.canonical_records.iter())
                    .enumerate()
                {
                    if row_index > 0 {
                        digest.update(b",");
                    }
                    digest.update(row.as_bytes());
                }
                digest.update(b"]");
            }
            "proposed_dependencies" => {
                digest.update(b"[");
                for (row_index, row) in observations
                    .iter()
                    .flat_map(|observation| observation.canonical_dependencies.iter())
                    .enumerate()
                {
                    if row_index > 0 {
                        digest.update(b",");
                    }
                    digest.update(row.as_bytes());
                }
                digest.update(b"]");
            }
            _ => digest.update(canonical_json(core.get(key).expect("core key exists")).as_bytes()),
        }
    }
    digest.update(b"}");
    let bytes = digest.finalize();
    let mut encoded = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        let _ = write!(&mut encoded, "{byte:02x}");
    }
    Ok(format!("sha256:{encoded}"))
}

/// Keep the legacy owner-derived request identity byte-compatible for normal
/// paths, but bound it for repositories whose generated artifact identity is
/// longer than the closed worker-protocol limit.
fn semantic_request_id(owner_artifact_id: &str) -> String {
    let legacy = format!("request:work:{owner_artifact_id}");
    if legacy.len() <= 240 {
        legacy
    } else {
        format!(
            "request:work:{}",
            canonical_sha256(&Value::String(owner_artifact_id.to_owned()))
        )
    }
}

fn bounded_protocol_identifier(value: String) -> String {
    if value.len() <= 240
        && !value
            .bytes()
            .any(|byte| matches!(byte, 0 | b'\r' | b'\n' | b'\t'))
    {
        value
    } else {
        format!("id:{}", canonical_sha256(&Value::String(value)))
    }
}

fn semantic_request(
    request: &GenerationRequest,
    _input: &JstsGenerationInput,
    semantic: &JstsSemanticInput,
    owner: &SourceInput,
    owner_files: &[SourceInput],
    semantic_scope_ref: Option<&str>,
    hybrid: Option<&OwnerSemantics>,
) -> Value {
    let work_item_id = format!("work:{}", owner.artifact_id);
    let request_id = semantic_request_id(&owner.artifact_id);
    let context_digest = canonical_sha256(&serde_json::json!({
        "registry": semantic.registry_digest,
        "owner": owner.artifact_version_id,
        "inputs_digest": semantic.inputs_digest,
    }));
    let scope = serde_json::json!({
        "replacement_scope_id": format!("scope:{}", owner.artifact_id),
        "owner_artifact_id": owner.artifact_id,
        "owner_artifact_version_id": owner.artifact_version_id,
        "capability": semantic.stage_capabilities.first().cloned().unwrap_or_else(|| "core:call_relationships".into()),
        "record_categories": ["diagnostic", "entity", "relation"],
        "record_kinds": semantic.stage_record_kinds,
        "base_record_set_digest": canonical_sha256(&serde_json::json!([])),
        "output_completeness": "accept_reported",
    });
    let mut work_item = serde_json::json!({
        "work_item_id": work_item_id,
        "workspace_id": request.workspace_id,
        "artifact_id": owner.artifact_id,
        "target_artifact_version_id": owner.artifact_version_id,
        "operation": "full",
        "plugin_id": semantic.plugin_id,
        "plugin_version": semantic.plugin_version,
        "capabilities": semantic.stage_capabilities,
        "expected_replacement_scopes": [scope],
        "reason_codes": ["core:artifact_changed"],
        "cause_references": [],
        "analysis_context_digest": context_digest,
        "work_item_digest": canonical_sha256(&serde_json::json!({ "workItemId": format!("work:{}", owner.artifact_id), "contextDigest": context_digest })),
        "candidate_generation_id": request.candidate_generation_id,
    });
    if let Some(base_snapshot_id) = semantic.base_snapshot_id.as_ref() {
        work_item["base_snapshot_id"] = Value::String(base_snapshot_id.clone());
    }
    let entries = owner_files
        .iter()
        .map(|file| {
            serde_json::json!({
                "artifact_id": file.artifact_id,
                "artifact_version_id": file.artifact_version_id,
                "content_hash": file.content_digest,
                "access_modes": ["artifact_read"],
            })
        })
        .collect::<Vec<_>>();
    let manifest_core = serde_json::json!({
        "request_id": request_id,
        "analysis_view_digest": context_digest,
        "artifact_version_entries": entries,
        "record_entries": [], "lookup_entries": [], "transitive_artifact_version_ids": [],
    });
    let inputs_digest = canonical_sha256_array(
        manifest_core
            .get("artifact_version_entries")
            .and_then(Value::as_array)
            .expect("manifest artifact version entries"),
    );
    let manifest_digest = canonical_sha256(&manifest_core);
    let mut manifest = manifest_core;
    manifest.as_object_mut().expect("manifest object").insert("plugin_input_access_manifest_id".into(), Value::String(canonical_sha256(&serde_json::json!({
        "request_id": semantic_request_id(&owner.artifact_id), "analysis_view_digest": context_digest,
    }))));
    manifest
        .as_object_mut()
        .expect("manifest object")
        .insert("manifest_digest".into(), Value::String(manifest_digest));
    let analysis_input_digest = canonical_sha256(&serde_json::json!({
        "owner": owner.path,
        "inputs_digest": inputs_digest,
    }));
    let wire_files = owner_files
        .iter()
        .map(|file| {
            serde_json::json!({
                "path": file.path,
                "artifact_id": file.artifact_id,
                "artifact_version_id": file.artifact_version_id,
                "content_hash": file.content_digest,
            })
        })
        .collect::<Vec<_>>();
    let mut payload = serde_json::json!({
        "files": wire_files,
        // The complete root set is captured by `analyze_closure`. Owner
        // requests carry only their local root marker; the checker resolves
        // cross-file declarations through the already prepared project and
        // validates the shared scope by digest. Repeating all roots here was
        // a corpus-sized JSON copy for every owner.
        "root_names": [owner.path],
        "owner_path": owner.path,
        "work_item": work_item,
        "accepted_manifest": manifest,
        // Keep the stage filter explicit at the Rust↔checker boundary. The
        // semantic worker uses it to avoid type queries for stages that do
        // not publish inferred-type rows (stage 2 still opts in because its
        // spool is the source for the cumulative stage 3 projection).
        "stage_record_kinds": semantic.stage_record_kinds,
        "analysis_digest": semantic.analysis_digest,
        "analysis_configuration_digest": semantic.analysis_configuration_digest,
        "analysis_input_digest": analysis_input_digest,
        "created_at": semantic.created_at,
        // The composition worker owns FactDelta identities and digests. The
        // checker therefore returns canonical observations only and does not
        // build a transient stream header for each owner.
        "rust_owned_digests": true,
    });
    if let Some(stage) = semantic.publication_stage_id.as_ref() {
        payload["publication_stage_id"] = Value::String(stage.clone());
    }
    if let Some(stages) = semantic.included_publication_stage_ids.as_ref() {
        payload["included_publication_stage_ids"] = serde_json::json!(stages);
    }
    if let Some(scope_ref) = semantic_scope_ref {
        // The checker receives the complete scope once during preparation.
        // Every owner in a bounded group shares that immutable scope; carry
        // only its canonical reference on the hot owner requests so the
        // affected-path manifest is not serialized 32 times per group.
        payload["rust_semantic_scope_ref"] = Value::String(scope_ref.to_owned());
    }
    if let Some(semantics) = hybrid {
        // F5 hybrid handoff (E1b, design doc step 3): a backward-compatible
        // addition to the protocol. `rust-semantic-worker.ts`/`worker.ts`
        // read only the specific payload keys they know about (no strict
        // schema), so these two new optional fields are inert until E1c
        // teaches the checker-backed walk to descend straight to just the
        // pending spans instead of collecting every site itself.
        //
        // Safe-partition rule (coordinator directive, 2026-09-01): a JSDoc-
        // typed owner's `pending_sites` cannot carry its JSDoc-embedded type
        // references at all -- oxc never materializes JSDoc comment content
        // as AST nodes, so there is no node to site -- so `pending_sites`
        // must NOT be handed to the checker-backed walk for this owner; an
        // absent `rust_hybrid_pending_sites` is exactly the signal
        // `walkRustSemanticOwner`/`beginRustSemanticOwnerGroup` already read
        // as "fall back to the full, un-cut-over walk for this one owner"
        // (see `OwnerSemantics::jsdoc_typed_file`'s doc comment).
        if !semantics.jsdoc_typed_file {
            payload["rust_hybrid_pending_sites"] =
                serde_json::to_value(&semantics.pending_sites).unwrap_or(Value::Array(Vec::new()));
        }
        payload["rust_hybrid_sites_digest"] = Value::String(semantics.sites_digest.clone());
    }
    serde_json::json!({
        "protocol_version": "1.0.0",
        "request_id": request_id,
        "request_digest": canonical_sha256(&serde_json::json!({ "request_id": request_id, "analysis_input_digest": analysis_input_digest })),
        "call": "analyze_artifact",
        "deadline": "2099-01-01T00:00:00.000Z",
        "cancellation_id": format!("cancel:{}", work_item_id),
        "payload": payload,
    })
}

fn run_jsts_semantic_generation(
    checker: &mut SemanticChecker,
    core: &mut IndexingCore,
    request: &GenerationRequest,
    input: &JstsGenerationInput,
    summary: &JstsGenerationSummary,
    descriptor: &urdira_worker_protocol::SemanticEngineDescriptor,
    syntax: &SyntaxWorkerState,
) -> Result<(u64, u64, u64), CoreError> {
    let semantic_started = Instant::now();
    let semantic = input
        .semantic
        .as_ref()
        .ok_or_else(|| CoreError("JS/TS semantic input is missing".into()))?;
    let semantic_scope = serde_json::json!({
        "authority": "urdira:jsts-syntax-worker",
        "changed_paths": match &request.change_set {
            urdira_worker_protocol::AuthoritativeChangeSet::Full => input.root_names.clone(),
            urdira_worker_protocol::AuthoritativeChangeSet::Exact { changed_artifact_ids } => input.files.iter().filter(|file| changed_artifact_ids.iter().any(|id| id == &file.artifact_id)).map(|file| file.path.clone()).collect::<Vec<_>>(),
        },
        "affected_paths": summary.affected_paths,
    });
    let semantic_scope_id = canonical_sha256(&semantic_scope);
    // F5 hybrid lane (E1b, flag-gated): kick off the Rust `oxc_semantic`
    // reference pass on a background thread before the checker's own
    // `analyze_closure` preparation call below (a real, measured wall-clock
    // cost: "semantic closure lane=primary elapsed_ms=..."). The hybrid pass
    // is entirely in-process CPU work with no dependency on that call, so
    // running it concurrently instead of after buys the overlap the design
    // asks for ("para que no serialice") instead of adding to the critical
    // path. It is joined (blocking) just before the per-owner request loop
    // below, because `pending_sites`/`sites_digest` need to already be on
    // hand to embed in each owner's `semantic_request` payload (step 3 of
    // the handoff), not just at merge time.
    let hybrid_active = hybrid_semantics_enabled();
    // P0-S2 prototype (typeflow): read once, up front, so both the spawned
    // thread below AND the post-join owner loop (`census_typeflow_owner`)
    // see the same value for this whole generation.
    let typeflow_active = typeflow_enabled();
    let typeflow_oracle_active = typeflow_active && typeflow_oracle_enabled();
    // E2: build this generation's `WorkspaceResolver`/available-path-set/
    // resolved-files-map up front (moved wholesale into the spawned
    // thread below, not shared, so no `Arc` is needed) so the hybrid pass
    // can close import -> export -> declaration chains. `syntax.
    // project_files` is the SAME lane-1 result `run_jsts_generation` (the
    // caller, just before this function) already produced for
    // `input.project_key` -- one resolver rebuild, cheap relative to
    // lane 1's own parse, not a second source-of-truth.
    let hybrid_handle = if hybrid_active {
        let resolver_assets =
            decode_config_assets(input.config_assets.clone()).map_err(|error| {
                CoreError(format!("hybrid resolver assets invalid: {}", error.message))
            })?;
        let resolver = WorkspaceResolver::build(&resolver_assets);
        let available: BTreeSet<String> =
            input.files.iter().map(|file| file.path.clone()).collect();
        let files: BTreeMap<String, SyntaxFileResult> = syntax
            .project_files(&input.project_key)
            .cloned()
            .unwrap_or_default();
        let paths = summary.affected_paths.clone();
        let owner_files = input.files.clone();
        // P0-S2 prototype (typeflow): built on this SAME background thread,
        // before the hybrid pass, so it overlaps with the checker's own
        // closure-preparation call below exactly like the rest of this
        // thread's work already does. `None` when the flag is off -- every
        // typeflow branch downstream degrades to the pre-existing E1-E3
        // behavior (see `HybridResolutionContext::typeflow_index`'s doc
        // comment).
        Some(std::thread::spawn(move || {
            let by_path = owner_files
                .iter()
                .map(|file| (file.path.as_str(), file))
                .collect::<HashMap<_, _>>();
            let typeflow_index = typeflow_active
                .then(|| build_typeflow_program_index(&owner_files, &resolver, &available, &files));
            // Ambient module resolution task (2026-09-04): v3's own real
            // TypeScript checker (downstream of this lexical hybrid
            // pre-pass) already resolves a `declare module "x" { ... }`
            // block natively -- this pre-pass never needed ambient
            // awareness before this field existed and still does not, so
            // an EMPTY index (never resolves ambiently, every specifier
            // falls through to this pass's pre-existing behavior
            // unchanged) preserves that exactly.
            let ambient_index = urdira_jsts_syntax_worker::AmbientModuleIndex::default();
            let ctx = HybridResolutionContext {
                resolver: &resolver,
                available: &available,
                files: &files,
                typeflow_index: typeflow_index.as_ref(),
                typeflow_oracle: typeflow_oracle_active,
                ambient_index: &ambient_index,
            };
            compute_hybrid_semantics(&paths, &by_path, &ctx)
        }))
    } else {
        None
    };
    let closure_request = serde_json::json!({
        "protocol_version": "1.0.0", "request_id": format!("request:closure:{}", request.candidate_generation_id),
        "request_digest": canonical_sha256(&serde_json::json!({ "inputs_digest": semantic.inputs_digest, "configuration_digest": semantic.analysis_configuration_digest })),
        "call": "analyze_closure", "deadline": "2099-01-01T00:00:00.000Z", "cancellation_id": format!("cancel:closure:{}", request.candidate_generation_id),
        "payload": {
            "files": input.files.iter().map(|file| serde_json::json!({ "path": file.path, "artifact_id": file.artifact_id, "artifact_version_id": file.artifact_version_id, "content_hash": file.content_digest })).collect::<Vec<_>>(),
            "root_names": input.root_names,
            "publication_stage_id": semantic.publication_stage_id,
            "included_publication_stage_ids": semantic.included_publication_stage_ids,
            "rust_semantic_scope": semantic_scope.clone(),
            "rust_semantic_scope_id": semantic_scope_id,
        },
    });
    // The closure call remains the checker-side preparation/authority check for
    // the Rust affected set. Its response is intentionally discarded: with a
    // Rust semantic scope the checker keeps the complete prepared program and
    // returns no closure payload. Re-materialising that map here would only
    // duplicate the same corpus-sized metadata before owner groups run.
    let closure_request = Arc::new(closure_request);
    let closure_started = Instant::now();
    let _ = checker.invoke_ref(closure_request.as_ref())?;
    if std::env::var_os("URDIRA_DEBUG_TIMING").is_some() {
        eprintln!(
            "[urdira-indexing-worker] semantic closure lane=primary elapsed_ms={}",
            closure_started.elapsed().as_millis()
        );
    }
    let files_by_path = input
        .files
        .iter()
        .map(|file| (file.path.as_str(), file))
        .collect::<HashMap<_, _>>();
    // Join the hybrid pass now: every owner's `pending_sites`/`sites_digest`
    // must already be on hand for the request-building loop right below.
    // With the flag off this is an empty map and every downstream hybrid
    // branch below is a no-op, so the request payload and merge behavior
    // are both byte-identical to before E1b.
    let hybrid_semantics: HashMap<String, OwnerSemantics> = match hybrid_handle {
        Some(handle) => handle
            .join()
            .map_err(|_| CoreError("hybrid semantics worker thread panicked".into()))??,
        None => HashMap::new(),
    };
    // E1c cutover invariant (design doc E1, step 3 of the handoff): once
    // `rust_hybrid_pending_sites` is on the wire, the checker-backed walk in
    // analyzer.ts stops emitting `core:references` for any site Rust did not
    // list as pending (`walkRustSemanticOwner`/`beginRustSemanticOwnerGroup`).
    // The two productions are then a disjoint partition by construction, so
    // ANY collision is a real double-emission bug, not an expected outcome to
    // count and skip -- strict mode defaults to on whenever the hybrid lane
    // itself is on. `URDIRA_JSTS_HYBRID_STRICT_MERGE` remains available as an
    // explicit override in either direction (e.g. "0" to keep dry/census mode
    // while still exercising the cutover request payload during rollout).
    let hybrid_strict_merge = hybrid_strict_merge_from(
        std::env::var("URDIRA_JSTS_HYBRID_STRICT_MERGE")
            .ok()
            .as_deref(),
        hybrid_active,
    );
    let mut hybrid_total_attempted = 0_usize;
    let mut hybrid_total_collisions = 0_usize;
    let mut hybrid_total_merged = 0_usize;
    let mut hybrid_example_collision: Option<(String, String)> = None;
    let mut hybrid_total_class_a = 0_usize;
    let mut hybrid_total_class_b = 0_usize;
    const HYBRID_CENSUS_EXAMPLE_CAP: usize = 20;
    let mut hybrid_class_a_examples = Vec::<HybridClassExample>::new();
    let mut hybrid_class_b_examples = Vec::<HybridClassExample>::new();
    // P0-S2 prototype (typeflow oracle census, see `census_typeflow_owner`'s
    // doc comment). Stays all-zero whenever oracle mode is off.
    let mut typeflow_census = TypeflowCensus::default();
    // Diagnostic (2026-09-02 debugging session): how many times the
    // per-owner census hook branch runs at all, and how often the owner
    // path was actually found in `hybrid_semantics`.
    let mut typeflow_census_branch_entries = 0_usize;
    let mut typeflow_census_branch_hits = 0_usize;
    let mut typeflow_census_branch_misses = 0_usize;
    // In the combined direct generation the syntax lane has already accepted
    // `summary.group_count` receipts. Continue the same generic sequence for
    // semantic groups so syntax and semantic rows can be committed atomically
    // without colliding receipt identities.
    let mut group_sequence = if request.direct_publication {
        summary.group_count
    } else {
        0_u64
    };
    let mut owners_count = 0_u64;
    let mut rows_count = 0_u64;
    let mut pending = Vec::<urdira_indexing_core::CanonicalOwnerObservation>::new();
    let mut pending_rows = 0_usize;
    let mut pending_bytes = 0_usize;
    let mut pending_owners = HashSet::<(String, String)>::new();
    let mut request_groups = Vec::<Vec<Arc<Value>>>::new();
    for chunk in summary.affected_paths.chunks(32) {
        let mut requests = Vec::with_capacity(chunk.len());
        for path in chunk {
            let owner = files_by_path.get(path.as_str()).ok_or_else(|| {
                CoreError(format!("affected path is outside source manifest: {path}"))
            })?;
            requests.push(Arc::new(semantic_request(
                request,
                input,
                semantic,
                owner,
                std::slice::from_ref(owner),
                Some(&semantic_scope_id),
                hybrid_semantics.get(path.as_str()),
            )));
        }
        request_groups.push(requests);
    }
    // Keep one owned request envelope per group. The processing closure only
    // needs to read each owner's payload while the checker result is being
    // accepted; cloning every JSON envelope into a second corpus-sized flat
    // vector duplicated allocations for large cold generations.
    let requests_for_processing = request_groups
        .iter()
        .flat_map(|group| group.iter().cloned())
        .collect::<Vec<_>>();
    // `semantic_scope` is the same immutable envelope sent by the closure
    // preparation call. Owner requests carry only its digest reference.
    // Match the checker bridge's closed 32-owner group bound directly. The
    // checker subprocesses below may run groups concurrently, but this
    // closure remains the sole place that accepts them into Rust staging, in
    // deterministic group order.
    let mut process_owner = |owner_index: usize,
                             owner: SemanticBridgeOwner|
     -> Result<(), CoreError> {
        let semantic_payload = requests_for_processing
            .get(owner_index)
            .and_then(|value| value.get("payload"))
            .ok_or_else(|| CoreError("semantic checker owner request is missing payload".into()))?;
        let diagnostic_proposal_keys = owner.diagnostic_proposal_keys.clone();
        let hybrid_identity = HybridOwnerIdentity {
            path: owner.owner_path.clone(),
            artifact_id: owner.owner_artifact_id.clone(),
            artifact_version_id: owner.owner_artifact_version_id.clone(),
        };
        let mut observations = bounded_semantic_observations(owner);
        if typeflow_oracle_active {
            typeflow_census_branch_entries += 1;
            match hybrid_semantics.get(&hybrid_identity.path) {
                Some(semantics) => {
                    typeflow_census_branch_hits += 1;
                    census_typeflow_owner(
                        &observations,
                        semantics,
                        &hybrid_identity.path,
                        &mut typeflow_census,
                    );
                }
                None => {
                    typeflow_census_branch_misses += 1;
                }
            }
        }
        if let Some(semantics) = hybrid_semantics.get(&hybrid_identity.path) {
            let stats = merge_hybrid_reference_rows(
                &mut observations,
                semantics,
                &hybrid_identity,
                hybrid_strict_merge,
            )?;
            hybrid_total_attempted = hybrid_total_attempted.saturating_add(stats.attempted);
            hybrid_total_collisions = hybrid_total_collisions.saturating_add(stats.collisions);
            hybrid_total_merged = hybrid_total_merged.saturating_add(stats.merged);
            if stats.collisions > 0 && hybrid_example_collision.is_none() {
                hybrid_example_collision = Some((
                    hybrid_identity.path.clone(),
                    stats
                        .example_collision_key
                        .expect("collisions implies an example key"),
                ));
            }
            hybrid_total_class_a = hybrid_total_class_a.saturating_add(stats.class_a_disagreements);
            hybrid_total_class_b = hybrid_total_class_b.saturating_add(stats.class_b_omissions);
            if hybrid_class_a_examples.len() < HYBRID_CENSUS_EXAMPLE_CAP {
                hybrid_class_a_examples.extend(
                    stats
                        .class_a_examples
                        .into_iter()
                        .take(HYBRID_CENSUS_EXAMPLE_CAP - hybrid_class_a_examples.len()),
                );
            }
            if hybrid_class_b_examples.len() < HYBRID_CENSUS_EXAMPLE_CAP {
                hybrid_class_b_examples.extend(
                    stats
                        .class_b_examples
                        .into_iter()
                        .take(HYBRID_CENSUS_EXAMPLE_CAP - hybrid_class_b_examples.len()),
                );
            }
        }
        let rust_delta_digest =
            rust_semantic_delta_digest(semantic_payload, &observations, &diagnostic_proposal_keys)?;
        for observation in &mut observations {
            if observation.fact_delta_id.is_none() {
                observation.fact_delta_id = Some(format!(
                    "jsts:delta:{}:work:{}:{}",
                    request.candidate_generation_id,
                    observation.owner_artifact_id,
                    observation.sequence
                ));
            }
            if observation.delta_digest.is_none() {
                observation.delta_digest = Some(rust_delta_digest.clone());
            }
        }
        rows_count = rows_count.saturating_add(
            observations
                .iter()
                .map(|observation| {
                    (observation.canonical_records.len() + observation.canonical_dependencies.len())
                        as u64
                })
                .sum::<u64>(),
        );
        if !observations.is_empty() {
            for observation in observations {
                let observation_rows =
                    observation.canonical_records.len() + observation.canonical_dependencies.len();
                let observation_bytes = observation
                    .canonical_records
                    .iter()
                    .map(String::len)
                    .sum::<usize>()
                    + observation
                        .canonical_dependencies
                        .iter()
                        .map(String::len)
                        .sum::<usize>();
                let owner_key = (
                    observation.owner_artifact_id.clone(),
                    observation.owner_artifact_version_id.clone(),
                );
                if !pending.is_empty()
                    && ((!pending_owners.contains(&owner_key)
                        && pending_owners.len() >= urdira_indexing_core::MAX_GROUP_OWNERS)
                        || pending_rows.saturating_add(observation_rows)
                            > urdira_indexing_core::MAX_GROUP_ROWS
                        || pending_bytes.saturating_add(observation_bytes)
                            > urdira_indexing_core::MAX_GROUP_BYTES)
                {
                    core.accept_canonical_group_owned(CanonicalPhysicalGroup {
                        group_sequence,
                        owners: std::mem::take(&mut pending),
                    })?;
                    group_sequence = group_sequence.saturating_add(1);
                    pending_rows = 0;
                    pending_bytes = 0;
                    pending_owners.clear();
                }
                pending_rows = pending_rows.saturating_add(observation_rows);
                pending_bytes = pending_bytes.saturating_add(observation_bytes);
                pending_owners.insert(owner_key);
                pending.push(observation);
            }
            owners_count = owners_count.saturating_add(1);
        }
        Ok(())
    };

    // Build the immutable request lookup once. The processing closure uses it
    // only for each owner's delta commitment; the worker threads receive owned
    // request groups and never touch SQLite or the core.
    let parallelism = semantic_parallelism(summary.affected_paths.len());
    if parallelism <= 1 || request_groups.len() <= 1 {
        for (group_index, requests) in request_groups.iter().enumerate() {
            for (owner_index, owner) in analyze_semantic_pages(checker, requests)?
                .into_iter()
                .enumerate()
            {
                process_owner(group_index * 32 + owner_index, owner)?;
            }
        }
    } else {
        use std::sync::mpsc::{self, Receiver, SyncSender};

        type GroupResult = Result<(usize, Vec<SemanticBridgeOwner>), CoreError>;
        // Partition groups into contiguous per-lane blocks rather than
        // round-robin. The checker's windowed root cache (analyzer.ts,
        // rustSemanticWindowed) advances through rootNames in fixed-size
        // windows; round-robin assignment made every lane cross a window
        // boundary every ~2.7 groups, forcing a project rebuild on almost
        // every group per lane. A contiguous block keeps each lane inside a
        // handful of windows, cutting rebuilds roughly sixfold. Reassembly
        // below is keyed by group_index and drains strictly in that order
        // regardless of which lane produced a result or when, so this
        // repartitioning changes lane scheduling only -- publication order
        // and the resulting digest are unaffected.
        let block_size = request_groups.len().div_ceil(parallelism);
        let mut lane_groups = vec![Vec::<(usize, Vec<Arc<Value>>)>::new(); parallelism];
        for (group_index, requests) in request_groups.iter().cloned().enumerate() {
            lane_groups[group_index / block_size].push((group_index, requests));
        }
        let (sender, receiver): (SyncSender<GroupResult>, Receiver<GroupResult>) =
            mpsc::sync_channel(parallelism);
        let mut joins = Vec::with_capacity(parallelism.saturating_sub(1));
        for lane in lane_groups.into_iter().skip(1) {
            let lane_sender = sender.clone();
            let lane_descriptor = descriptor.clone();
            let lane_closure_request = Arc::clone(&closure_request);
            joins.push(std::thread::spawn(move || {
                let mut lane_checker = match SemanticChecker::spawn(&lane_descriptor) {
                    Ok(checker) => checker,
                    Err(error) => {
                        let _ = lane_sender.send(Err(error));
                        return;
                    }
                };
                let result = (|| {
                    let closure_started = Instant::now();
                    lane_checker.invoke_ref(lane_closure_request.as_ref())?;
                    if std::env::var_os("URDIRA_DEBUG_TIMING").is_some() {
                        eprintln!(
                            "[urdira-indexing-worker] semantic closure lane=extra elapsed_ms={}",
                            closure_started.elapsed().as_millis()
                        );
                    }
                    let mut output = Vec::new();
                    for (group_index, requests) in lane {
                        output.push((
                            group_index,
                            analyze_semantic_pages(&mut lane_checker, &requests)?,
                        ));
                    }
                    Ok(output)
                })();
                match result {
                    Ok(groups) => {
                        for group in groups {
                            if lane_sender.send(Ok(group)).is_err() {
                                break;
                            }
                        }
                    }
                    Err(error) => {
                        let _ = lane_sender.send(Err(error));
                    }
                }
                lane_checker.shutdown();
            }));
        }
        drop(sender);
        // Lane zero stays on the reusable checker. Its groups are processed
        // on this thread while the extra private checkers run concurrently.
        let mut primary = VecDeque::<(usize, Vec<SemanticBridgeOwner>)>::new();
        let mut extras = BTreeMap::<usize, Vec<SemanticBridgeOwner>>::new();
        let mut next_group = 0_usize;
        let mut drain = |next_group: &mut usize,
                         primary: &mut VecDeque<(usize, Vec<SemanticBridgeOwner>)>,
                         extras: &mut BTreeMap<usize, Vec<SemanticBridgeOwner>>|
         -> Result<(), CoreError> {
            while let Some(owners) = extras.remove(next_group) {
                for (owner_index, owner) in owners.into_iter().enumerate() {
                    process_owner(*next_group * 32 + owner_index, owner)?;
                }
                *next_group += 1;
            }
            while let Some((group_index, _owners)) = primary.front() {
                if *group_index != *next_group {
                    break;
                }
                let (_, owners) = primary.pop_front().expect("primary group present");
                for (owner_index, owner) in owners.into_iter().enumerate() {
                    process_owner(*next_group * 32 + owner_index, owner)?;
                }
                *next_group += 1;
            }
            Ok(())
        };
        for (group_index, requests) in request_groups
            .iter()
            .enumerate()
            .filter(|(index, _)| *index < block_size)
        {
            primary.push_back((group_index, analyze_semantic_pages(checker, requests)?));
            while let Ok(result) = receiver.try_recv() {
                let group = result?;
                extras.insert(group.0, group.1);
                drain(&mut next_group, &mut primary, &mut extras)?;
            }
            drain(&mut next_group, &mut primary, &mut extras)?;
        }
        for result in receiver {
            let group = result?;
            extras.insert(group.0, group.1);
            drain(&mut next_group, &mut primary, &mut extras)?;
        }
        for join in joins {
            join.join()
                .map_err(|_| CoreError("semantic checker lane panicked".into()))?;
        }
        drain(&mut next_group, &mut primary, &mut extras)?;
        if next_group != requests_for_processing.len().div_ceil(32) {
            return Err(CoreError(
                "parallel semantic checker returned incomplete groups".into(),
            ));
        }
    }
    if !pending.is_empty() {
        core.accept_canonical_group_owned(CanonicalPhysicalGroup {
            group_sequence,
            owners: pending,
        })?;
        group_sequence = group_sequence.saturating_add(1);
    }
    if std::env::var_os("URDIRA_DEBUG_TIMING").is_some() {
        eprintln!(
            "[urdira-indexing-worker] jsts semantic generation owners={} groups={} elapsed_ms={}",
            owners_count,
            group_sequence,
            semantic_started.elapsed().as_millis()
        );
        if hybrid_active {
            eprintln!(
                "[urdira-indexing-worker] jsts hybrid merge mode={} attempted={} merged={} collisions={} example={:?}",
                if hybrid_strict_merge { "strict" } else { "dry" },
                hybrid_total_attempted,
                hybrid_total_merged,
                hybrid_total_collisions,
                hybrid_example_collision
            );
            eprintln!(
                "[urdira-indexing-worker] jsts hybrid census class_a_disagreements={} class_b_omissions={}",
                hybrid_total_class_a, hybrid_total_class_b
            );
            for example in &hybrid_class_a_examples {
                eprintln!(
                    "[urdira-indexing-worker] jsts hybrid census class=A owner={} start={} end={} rust_key={} checker_keys={:?}",
                    example.owner_path,
                    example.start,
                    example.end,
                    example.rust_identity_key,
                    example.checker_identity_keys
                );
            }
            for example in &hybrid_class_b_examples {
                eprintln!(
                    "[urdira-indexing-worker] jsts hybrid census class=B owner={} start={} end={} rust_key={}",
                    example.owner_path, example.start, example.end, example.rust_identity_key
                );
            }
        }
    }
    if std::env::var_os("URDIRA_DEBUG_TIMING").is_some() {
        eprintln!(
            "[urdira-indexing-worker] typeflow census diagnostic branch_entries={} branch_hits={} branch_misses={} hybrid_semantics_len={}",
            typeflow_census_branch_entries,
            typeflow_census_branch_hits,
            typeflow_census_branch_misses,
            hybrid_semantics.len()
        );
    }
    if typeflow_oracle_active && let Some(output_path) = typeflow_oracle_output_path() {
        if std::env::var_os("URDIRA_DEBUG_TIMING").is_some() {
            eprintln!(
                "[urdira-indexing-worker] typeflow census pre-write in_memory_calls_attempted={} in_memory_heritage_attempted={} owners_censused={} output_path={:?} output_path_exists_before_write={}",
                typeflow_census.calls.attempted_sites,
                typeflow_census.heritage.attempted_sites,
                typeflow_census.owners_censused,
                output_path,
                output_path.exists()
            );
        }
        write_typeflow_census(&output_path, &typeflow_census)?;
        if std::env::var_os("URDIRA_DEBUG_TIMING").is_some() {
            let post = std::fs::read(&output_path)
                .ok()
                .and_then(|bytes| serde_json::from_slice::<TypeflowCensus>(&bytes).ok());
            eprintln!(
                "[urdira-indexing-worker] typeflow census post-write on_disk_calls_attempted={:?} on_disk_owners_censused={:?}",
                post.as_ref().map(|census| census.calls.attempted_sites),
                post.as_ref().map(|census| census.owners_censused)
            );
        }
    }
    Ok((group_sequence, owners_count, rows_count))
}

/// P0-S2 prototype: write (or, across more than one generation in the same
/// process -- a mutation run -- ACCUMULATE into) the oracle census JSON at
/// `URDIRA_JSTS_TYPEFLOW_ORACLE_OUT`. A prior file from an earlier
/// generation this same run is read and summed field-by-field (a fresh
/// `TypeflowCensus` for a fresh run, since the caller is expected to point
/// this at a new/removed path per run); a missing or unparseable prior file
/// is treated as an empty census, never a hard failure -- the census itself
/// is diagnostic output, not a correctness-load-bearing artifact.
fn write_typeflow_census(path: &std::path::Path, census: &TypeflowCensus) -> Result<(), CoreError> {
    // Cross-process safety net (2026-09-02 debugging): even though the
    // production plumbing keys one `urdira-indexing-worker` process per
    // workspace (`indexingCoreSessions` in apps/urdira/src/index.ts), this
    // read-merge-write is not otherwise atomic, and a benchmark harness
    // that ever runs more than one such process against the SAME output
    // path would silently lose updates. A simple atomic-create lock file
    // (`O_EXCL` semantics via `create_new`) serializes every writer,
    // in-process or cross-process, at negligible cost for this
    // diagnostic-only artifact.
    let lock_path = path.with_extension("census-lock");
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
    loop {
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&lock_path)
        {
            Ok(_) => break,
            Err(_) if std::time::Instant::now() < deadline => {
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
            Err(error) => {
                return Err(CoreError(format!(
                    "typeflow census lock timed out for {lock_path:?}: {error}"
                )));
            }
        }
    }
    let result = (|| -> Result<(), CoreError> {
        let mut combined = match std::fs::read(path) {
            Ok(bytes) => match serde_json::from_slice::<TypeflowCensus>(&bytes) {
                Ok(parsed) => parsed,
                Err(error) => {
                    // A PARSE failure on an EXISTING file is a real bug (a
                    // schema drift, or the `skip_serializing_if`-without-
                    // `default` mistake this comment used to describe from
                    // experience) -- never treat it the same as "no prior
                    // file yet". Loud on stderr (this whole artifact is
                    // diagnostic-only, never worth failing the generation
                    // over) so a future regression here is visible
                    // immediately instead of silently discarding whatever
                    // was accumulated so far.
                    eprintln!(
                        "[urdira-indexing-worker] WARNING: typeflow census at {path:?} failed to parse ({error}); starting a fresh census instead of accumulating onto it"
                    );
                    TypeflowCensus::default()
                }
            },
            Err(_) => TypeflowCensus::default(),
        };
        combined.calls = sum_typeflow_edge_census(combined.calls, census.calls.clone());
        combined.heritage = sum_typeflow_edge_census(combined.heritage, census.heritage.clone());
        // P1-C fix: found live -- `identifier_calls` (added alongside
        // `calls`/`heritage`) was never listed here, so every generation's
        // own in-memory count was silently discarded on write, and the
        // on-disk census always read back zero regardless of how many
        // `call_target_uncertain` sites typeflow actually resolved. Same
        // "loud, not silent" discipline as this function's own doc comment
        // about a parse failure: a field added to `TypeflowCensus` without
        // a matching line here degrades to "measures nothing", not a
        // compile error, which is exactly how this went unnoticed until a
        // census run's own numbers were checked by hand.
        combined.identifier_calls =
            sum_typeflow_edge_census(combined.identifier_calls, census.identifier_calls.clone());
        combined.owners_censused += census.owners_censused;
        for (reason, count) in &census.call_and_heritage_reason_counts {
            *combined
                .call_and_heritage_reason_counts
                .entry(reason.clone())
                .or_insert(0) += count;
        }
        for (rule, count) in &census.resolved_by_rule {
            *combined.resolved_by_rule.entry(rule.clone()).or_insert(0) += count;
        }
        for (shape, count) in &census.receiver_shape_counts {
            *combined
                .receiver_shape_counts
                .entry(shape.clone())
                .or_insert(0) += count;
        }
        for (shape, samples) in &census.receiver_shape_samples {
            let entry = combined
                .receiver_shape_samples
                .entry(shape.clone())
                .or_default();
            entry.extend(samples.iter().cloned());
            entry.truncate(TYPEFLOW_SHAPE_SAMPLE_CAP);
        }
        for (basename, count) in &census.external_target_basename_counts {
            *combined
                .external_target_basename_counts
                .entry(basename.clone())
                .or_insert(0) += count;
        }
        let encoded = serde_json::to_vec_pretty(&combined)
            .map_err(|error| CoreError(format!("typeflow census encode failed: {error}")))?;
        std::fs::write(path, encoded).map_err(|error| {
            CoreError(format!(
                "typeflow census write failed for {path:?}: {error}"
            ))
        })
    })();
    let _ = std::fs::remove_file(&lock_path);
    result
}

fn sum_typeflow_edge_census(
    mut left: TypeflowEdgeCensus,
    right: TypeflowEdgeCensus,
) -> TypeflowEdgeCensus {
    left.attempted_sites += right.attempted_sites;
    left.both_confirmed_same_target += right.both_confirmed_same_target;
    left.both_confirmed_different_target += right.both_confirmed_different_target;
    left.checker_confirmed_rust_pending += right.checker_confirmed_rust_pending;
    left.checker_confirmed_external_target += right.checker_confirmed_external_target;
    left.checker_possible_or_missing_rust_confirmed +=
        right.checker_possible_or_missing_rust_confirmed;
    left.both_pending_or_possible += right.both_pending_or_possible;
    left.different_target_samples
        .extend(right.different_target_samples);
    left.different_target_samples
        .truncate(TYPEFLOW_CENSUS_SAMPLE_CAP);
    left.checker_confirmed_rust_pending_samples
        .extend(right.checker_confirmed_rust_pending_samples);
    left.checker_confirmed_rust_pending_samples
        .truncate(TYPEFLOW_CENSUS_SAMPLE_CAP);
    left
}

/// Adds the workspace-specific publication envelope around the generic
/// language-neutral sink. Typed receipt/staging/promotion logic lives only in
/// `urdira-indexing-core`; this wrapper performs final v3 publication in the
/// same transaction.
struct WorkspacePublicationSink {
    publication: Option<Value>,
}

impl PublicationSink for WorkspacePublicationSink {
    fn publish(
        &mut self,
        transaction: &Transaction<'_>,
        request: &GenerationRequest,
        descriptor: &GenerationDescriptor,
    ) -> Result<(), CoreError> {
        let mut generic = CandidatePublicationSink;
        generic.publish(transaction, request, descriptor)?;
        if let Some(publication) = self.publication.as_ref() {
            // The direct Rust path has already created both descriptors in
            // `CandidatePublicationSink::promote_direct_publication_metadata`.
            // Avoid the legacy empty-descriptor upserts here; they were only
            // needed by the TypeScript-shaped compatibility publication.
            if !request.direct_publication {
                let accepted_at = request.operation_id.as_str();
                transaction
                    .execute(
                        publication_v3_sql::CANDIDATE_PUBLICATION_DESCRIPTOR_EMPTY,
                        params![
                            &request.candidate_generation_id,
                            &request.workspace_id,
                            accepted_at
                        ],
                    )
                    .map_err(sql_error)?;
                transaction
                    .execute(
                        publication_v3_sql::CANDIDATE_PUBLICATION_PROJECTION_DESCRIPTOR_EMPTY,
                        params![
                            &request.candidate_generation_id,
                            &request.workspace_id,
                            accepted_at
                        ],
                    )
                    .map_err(sql_error)?;
            }
            finalize_workspace_publication(transaction, request, publication)?;
        }
        Ok(())
    }
}

fn value_string(value: &Value, key: &str) -> Result<String, CoreError> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| CoreError(format!("publication field {key} is missing")))
}

fn sql_error(error: rusqlite::Error) -> CoreError {
    CoreError(format!("Rust publication SQLite error: {error}"))
}

fn value_optional_string(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_owned)
}

fn json_text(value: &Value) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "null".into())
}

fn change_set_descriptor(text: &str, kind: &str) -> Value {
    let parsed = serde_json::from_str::<Value>(text).unwrap_or_else(|_| serde_json::json!({}));
    change_set_descriptor_value(parsed, kind)
}

/// Materialization descriptors use the ordered-set vocabulary (`element_type`)
/// while generation manifests use the closed `change_set_kind` vocabulary.
/// Normalize at the Rust publication boundary so the persisted manifest stays
/// byte-compatible with the TypeScript authority without retaining template
/// rows in the application process.
fn change_set_descriptor_value(value: Value, kind: &str) -> Value {
    let object = value.as_object().cloned().unwrap_or_default();
    serde_json::json!({
        "change_set_kind": kind,
        "entry_schema_version": object.get("element_schema_version").and_then(Value::as_str).unwrap_or("1"),
        "comparator_id": object.get("comparator_id").and_then(Value::as_str).unwrap_or("core:lexicographic_uri"),
        "comparator_version": object.get("comparator_version").and_then(Value::as_str).unwrap_or("1"),
        "entry_count": object.get("entry_count").and_then(Value::as_u64).unwrap_or(0),
        "content_digest": object.get("content_digest").and_then(Value::as_str).unwrap_or("sha256:0000000000000000000000000000000000000000000000000000000000000000"),
    })
}

fn uce_varint(mut value: usize, output: &mut Vec<u8>) {
    loop {
        let next = (value % 128) as u8;
        value /= 128;
        output.push(next | if value == 0 { 0 } else { 0x80 });
        if value == 0 {
            break;
        }
    }
}

fn uce(value: &Value, output: &mut Vec<u8>) {
    match value {
        Value::Null => output.push(0),
        Value::Bool(false) => output.push(1),
        Value::Bool(true) => output.push(2),
        Value::String(text) => {
            output.push(3);
            uce_varint(text.len(), output);
            output.extend_from_slice(text.as_bytes());
        }
        Value::Number(number) => {
            output.push(7);
            let parsed = number.as_f64().unwrap_or(0.0);
            output.extend_from_slice(&(if parsed == 0.0 { 0.0 } else { parsed }).to_be_bytes());
        }
        Value::Array(values) => {
            output.push(5);
            uce_varint(values.len(), output);
            for value in values {
                uce(value, output);
            }
        }
        Value::Object(object) => {
            let mut entries = object.iter().collect::<Vec<_>>();
            entries.sort_by(|left, right| left.0.as_bytes().cmp(right.0.as_bytes()));
            output.push(6);
            uce_varint(entries.len(), output);
            for (key, value) in entries {
                uce(&Value::String(key.clone()), output);
                uce(value, output);
            }
        }
    }
}

fn json_digest(value: &Value) -> String {
    let mut digest = String::from("sha256:");
    let mut encoded = Vec::new();
    uce(value, &mut encoded);
    for byte in Sha256::digest(encoded) {
        use std::fmt::Write as _;
        let _ = write!(&mut digest, "{byte:02x}");
    }
    digest
}

/// Hashes a value with the v3 logical-digest framing used by the TypeScript
/// canonical package. This is deliberately kept in the composition worker so
/// publication never needs to marshal projection/dependency rows through V8.
fn logical_digest(value: &Value, domain: &str) -> String {
    let mut bytes = Vec::new();
    logical_text(&mut bytes, domain);
    logical_value(&mut bytes, value);
    let mut digest = String::from("sha256:");
    for byte in Sha256::digest(bytes) {
        use std::fmt::Write as _;
        let _ = write!(&mut digest, "{byte:02x}");
    }
    digest
}

fn stable_id(kind: &str, value: &Value) -> String {
    format!(
        "{kind}:{}",
        logical_digest(value, "urdira:logical-value:v3").trim_start_matches("sha256:")
    )
}

fn logical_varint(mut value: usize, output: &mut Vec<u8>) {
    loop {
        let byte = (value % 128) as u8;
        value /= 128;
        output.push(byte | if value == 0 { 0 } else { 0x80 });
        if value == 0 {
            break;
        }
    }
}

fn logical_text(output: &mut Vec<u8>, value: &str) {
    output.push(7);
    logical_varint(value.len(), output);
    output.extend_from_slice(value.as_bytes());
}

fn logical_value(output: &mut Vec<u8>, value: &Value) {
    match value {
        Value::Null => output.push(3),
        Value::Bool(value) => {
            output.extend_from_slice(&[4, u8::from(*value)]);
        }
        Value::String(value) => logical_text(output, value),
        Value::Number(value) => {
            let number = value.as_f64().unwrap_or(0.0);
            if number.is_finite()
                && number.fract() == 0.0
                && number.abs() <= 9_007_199_254_740_991.0
            {
                output.push(5);
                logical_text(output, &number.trunc().to_string());
            } else {
                output.push(6);
                output.extend_from_slice(&(if number == 0.0 { 0.0 } else { number }).to_be_bytes());
            }
        }
        Value::Array(values) => {
            output.push(9);
            logical_varint(values.len(), output);
            for value in values {
                logical_value(output, value);
            }
        }
        Value::Object(fields) => {
            let mut keys = fields.keys().collect::<Vec<_>>();
            keys.sort_by(|left, right| left.as_bytes().cmp(right.as_bytes()));
            output.push(10);
            logical_varint(keys.len(), output);
            for key in keys {
                logical_text(output, key);
                output.extend_from_slice(&[4, 1]);
                logical_value(output, fields.get(key).expect("object key exists"));
            }
        }
    }
}

fn canonical_array_digest(values: &[Value]) -> String {
    let mut encoded = Vec::new();
    uce_varint(values.len(), &mut encoded);
    // canonical array framing is tag 5 followed by the element count.
    let mut bytes = vec![5];
    bytes.append(&mut encoded);
    for value in values {
        uce(value, &mut bytes);
    }
    let mut digest = String::from("sha256:");
    for byte in Sha256::digest(bytes) {
        use std::fmt::Write as _;
        let _ = write!(&mut digest, "{byte:02x}");
    }
    digest
}

/// Streams the fixed visible-record set digest directly from SQLite. The
/// previous implementation retained one serde_json object per visible record
/// until the final hash, which inflated the Rust worker heap and added a large
/// allocation pass at n8n scale. The object field order is fixed by UCE's
/// bytewise key comparator (`record_digest` before `record_id`).
fn canonical_visible_record_set_digest(
    transaction: &Transaction<'_>,
    workspace_id: &str,
    generation: i64,
) -> Result<String, CoreError> {
    let count: usize = transaction
        .query_row(
            "SELECT COUNT(*) FROM record_occurrences WHERE workspace_id = ?1 AND valid_from_generation <= ?2 AND (valid_to_generation IS NULL OR valid_to_generation > ?2)",
            params![workspace_id, generation],
            |row| row.get::<_, i64>(0),
        )
        .map_err(sql_error)?
        .try_into()
        .map_err(|_| CoreError("visible record count exceeds usize".into()))?;
    let mut hasher = Sha256::new();
    hasher.update([5]);
    let mut count_bytes = Vec::new();
    uce_varint(count, &mut count_bytes);
    hasher.update(count_bytes);
    let mut entry = Vec::with_capacity(96);
    let mut records = transaction
        .prepare(
            "SELECT record_id, record_digest FROM record_occurrences WHERE workspace_id = ?1 AND valid_from_generation <= ?2 AND (valid_to_generation IS NULL OR valid_to_generation > ?2) ORDER BY record_id",
        )
        .map_err(sql_error)?;
    let mut cursor = records
        .query(params![workspace_id, generation])
        .map_err(sql_error)?;
    let mut seen = 0_usize;
    while let Some(row) = cursor.next().map_err(sql_error)? {
        let record_id: String = row.get(0).map_err(sql_error)?;
        let record_digest: String = row.get(1).map_err(sql_error)?;
        entry.clear();
        // Keep the exact canonical object encoder as the byte authority. The
        // object is short-lived (one row), unlike the previous project-sized
        // `visible_values` array that retained every row until hashing.
        uce(
            &serde_json::json!({"record_id": record_id, "record_digest": record_digest}),
            &mut entry,
        );
        hasher.update(&entry);
        seen = seen.saturating_add(1);
    }
    if seen != count {
        return Err(CoreError(
            "visible record count changed during digest".into(),
        ));
    }
    let mut digest = String::from("sha256:");
    for byte in hasher.finalize() {
        use std::fmt::Write as _;
        let _ = write!(&mut digest, "{byte:02x}");
    }
    Ok(digest)
}

fn projection_set_entries(
    transaction: &Transaction<'_>,
    workspace_id: &str,
    generation: i64,
) -> Result<Value, CoreError> {
    let mut entries = Vec::new();
    for (kind, generator, table, id_column) in [
        (
            "graph",
            "urdira.storage.graph-adjacency",
            "graph_edges",
            "edge_id",
        ),
        (
            "dependency",
            "urdira.storage.reverse-dependency",
            "artifact_dependencies",
            "dependency_entry_id",
        ),
        (
            "metric",
            "urdira.storage.metric",
            "metric_projections",
            "metric_id",
        ),
    ] {
        let generator_configuration_digest = logical_digest(
            &serde_json::json!({
                "workspace_id": workspace_id,
                "projection_kind": kind,
                "generator": generator,
                "generator_version": "1",
            }),
            "urdira:projection-generator:v2",
        );
        // The previous implementation materialized one serde_json object per
        // projection row and sorted the complete vector before hashing.  On
        // n8n this made the final snapshot phase allocate and walk hundreds
        // of thousands of temporary objects.  Keep the exact logical-digest
        // framing, but stream the ordered rows into one compact byte buffer;
        // the SQL ordering is deterministic and the row payload is encoded
        // directly with the core logical-value codec.
        let projection_set_digest = streamed_projection_set_digest(
            transaction,
            workspace_id,
            generation,
            kind,
            generator,
            &generator_configuration_digest,
            table,
            id_column,
        )?;
        entries.push(serde_json::json!({
            "projection_kind": kind,
            "generator": generator,
            "generator_version": "1",
            "generator_configuration_digest": generator_configuration_digest,
            "projection_set_digest": projection_set_digest,
        }));
    }
    Ok(Value::Array(entries))
}

#[allow(clippy::too_many_arguments)]
fn streamed_projection_set_digest(
    transaction: &Transaction<'_>,
    workspace_id: &str,
    generation: i64,
    kind: &str,
    generator: &str,
    generator_configuration_digest: &str,
    table: &str,
    id_column: &str,
) -> Result<String, CoreError> {
    let filter = "workspace_id = ?1 AND valid_from_generation <= ?2 AND (valid_to_generation IS NULL OR valid_to_generation > ?2)";
    let count: usize = transaction
        .query_row(
            &format!("SELECT COUNT(*) FROM {table} WHERE {filter}"),
            params![workspace_id, generation],
            |row| row.get::<_, i64>(0),
        )
        .map_err(sql_error)?
        .try_into()
        .map_err(|_| CoreError("projection row count exceeds usize".into()))?;
    let mut bytes = Vec::with_capacity(count.saturating_mul(96).saturating_add(256));
    // logical_digest({ ... }, "urdira:projection-set:v2") with the object
    // keys in the canonical bytewise order: entries, generator,
    // generator_configuration_digest, generator_version, projection_kind.
    logical_text(&mut bytes, "urdira:projection-set:v2");
    bytes.push(10);
    logical_varint(5, &mut bytes);
    logical_text(&mut bytes, "entries");
    bytes.extend_from_slice(&[4, 1]);
    bytes.push(9);
    logical_varint(count, &mut bytes);
    let mut rows = transaction
        .prepare(&format!(
            "SELECT {id_column}, valid_from_generation, content_digest FROM {table} WHERE {filter} ORDER BY ({id_column} || '@' || valid_from_generation)"
        ))
        .map_err(sql_error)?;
    let mut cursor = rows
        .query(params![workspace_id, generation])
        .map_err(sql_error)?;
    let mut seen = 0_usize;
    while let Some(row) = cursor.next().map_err(sql_error)? {
        let id: String = row.get(0).map_err(sql_error)?;
        let valid_from: i64 = row.get(1).map_err(sql_error)?;
        let digest: String = row.get(2).map_err(sql_error)?;
        let projection_record_id = format!("{id}@{valid_from}");
        bytes.push(10);
        logical_varint(2, &mut bytes);
        logical_text(&mut bytes, "content_digest");
        bytes.extend_from_slice(&[4, 1]);
        logical_text(&mut bytes, &digest);
        logical_text(&mut bytes, "projection_record_id");
        bytes.extend_from_slice(&[4, 1]);
        logical_text(&mut bytes, &projection_record_id);
        seen = seen.saturating_add(1);
    }
    if seen != count {
        return Err(CoreError(
            "projection row count changed during digest".into(),
        ));
    }
    for (key, value) in [
        ("generator", generator),
        (
            "generator_configuration_digest",
            generator_configuration_digest,
        ),
        ("generator_version", "1"),
        ("projection_kind", kind),
    ] {
        logical_text(&mut bytes, key);
        bytes.extend_from_slice(&[4, 1]);
        logical_text(&mut bytes, value);
    }
    let mut digest = String::from("sha256:");
    for byte in Sha256::digest(bytes) {
        use std::fmt::Write as _;
        let _ = write!(&mut digest, "{byte:02x}");
    }
    Ok(digest)
}

fn apply_source_transitions(
    transaction: &Transaction<'_>,
    workspace_id: &str,
    generation: i64,
    transitions: Option<&Value>,
) -> Result<(), CoreError> {
    let Some(entries) = transitions.and_then(Value::as_array) else {
        return Ok(());
    };
    for entry in entries {
        let Some(object) = entry.as_object() else {
            continue;
        };
        let change = object.get("artifact_change").and_then(Value::as_object);
        if let Some(previous) = change
            .and_then(|value| value.get("previous_artifact_version_id"))
            .and_then(Value::as_str)
        {
            transaction.execute("UPDATE artifact_versions SET valid_to_generation = ?1 WHERE workspace_id = ?2 AND artifact_version_id = ?3 AND valid_to_generation IS NULL", params![generation, workspace_id, previous]).map_err(sql_error)?;
        }
        if let Some(previous) = change
            .and_then(|value| value.get("previous_tombstone_id"))
            .and_then(Value::as_str)
        {
            transaction.execute("UPDATE artifact_tombstones SET valid_to_generation = ?1, closing_artifact_change_id = ?2 WHERE workspace_id = ?3 AND artifact_tombstone_id = ?4 AND valid_to_generation IS NULL", params![generation, change.and_then(|v| v.get("artifact_change_id")).and_then(Value::as_str), workspace_id, previous]).map_err(sql_error)?;
        }
        if let Some(version) = object
            .get("target_artifact_version_without_generation")
            .and_then(Value::as_object)
        {
            transaction.execute("INSERT INTO artifact_versions (artifact_version_id, workspace_id, artifact_id, content_blob_id, content_hash, byte_length, encoding, language_hint, analysis_metadata_digest, created_from_observation_id, valid_from_generation, valid_to_generation) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, NULL) ON CONFLICT(artifact_version_id) DO UPDATE SET valid_to_generation = excluded.valid_to_generation WHERE artifact_versions.workspace_id = excluded.workspace_id AND artifact_versions.artifact_id = excluded.artifact_id AND artifact_versions.content_blob_id = excluded.content_blob_id AND artifact_versions.content_hash = excluded.content_hash AND artifact_versions.byte_length = excluded.byte_length AND artifact_versions.encoding = excluded.encoding AND artifact_versions.language_hint IS excluded.language_hint AND artifact_versions.analysis_metadata_digest = excluded.analysis_metadata_digest AND artifact_versions.created_from_observation_id = excluded.created_from_observation_id AND artifact_versions.valid_from_generation <= excluded.valid_from_generation AND artifact_versions.valid_to_generation IS excluded.valid_to_generation", params![value_optional_string(&Value::Object(version.clone()), "artifact_version_id"), workspace_id, value_optional_string(&Value::Object(version.clone()), "artifact_id"), value_optional_string(&Value::Object(version.clone()), "content_blob_id"), value_optional_string(&Value::Object(version.clone()), "content_hash"), version.get("byte_length").and_then(Value::as_i64), value_optional_string(&Value::Object(version.clone()), "encoding"), value_optional_string(&Value::Object(version.clone()), "language_hint"), value_optional_string(&Value::Object(version.clone()), "analysis_metadata_digest"), value_optional_string(&Value::Object(version.clone()), "created_from_observation_id"), generation]).map_err(sql_error)?;
        }
        if let Some(tombstone) = object
            .get("target_artifact_tombstone_without_generation")
            .and_then(Value::as_object)
        {
            let text = |key: &str| {
                tombstone.get(key).and_then(Value::as_str).or_else(|| {
                    change
                        .and_then(|value| value.get(key))
                        .and_then(Value::as_str)
                })
            };
            transaction.execute("INSERT INTO artifact_tombstones (artifact_tombstone_id, workspace_id, artifact_id, absence_kind, absence_reason_code, last_artifact_version_id, valid_from_generation, valid_to_generation, opening_artifact_change_id, closing_artifact_change_id, replacement_artifact_version_id, cause_references, lineage_evidence_record_ids) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL, ?8, NULL, NULL, ?9, ?10) ON CONFLICT(artifact_tombstone_id) DO UPDATE SET closing_artifact_change_id = excluded.closing_artifact_change_id, replacement_artifact_version_id = excluded.replacement_artifact_version_id WHERE artifact_tombstones.workspace_id = excluded.workspace_id AND artifact_tombstones.artifact_id = excluded.artifact_id AND artifact_tombstones.absence_kind = excluded.absence_kind AND artifact_tombstones.absence_reason_code = excluded.absence_reason_code AND artifact_tombstones.last_artifact_version_id = excluded.last_artifact_version_id AND artifact_tombstones.valid_from_generation <= excluded.valid_from_generation AND artifact_tombstones.valid_to_generation IS excluded.valid_to_generation AND artifact_tombstones.opening_artifact_change_id = excluded.opening_artifact_change_id AND artifact_tombstones.cause_references = excluded.cause_references AND artifact_tombstones.lineage_evidence_record_ids = excluded.lineage_evidence_record_ids", params![text("artifact_tombstone_id"), workspace_id, text("artifact_id"), text("absence_kind"), text("absence_reason_code"), text("last_artifact_version_id"), generation, text("opening_artifact_change_id"), text("cause_references").unwrap_or("[]"), text("lineage_evidence_record_ids").unwrap_or("[]")]).map_err(sql_error)?;
        }
    }
    Ok(())
}

/// Apply generic source-catalog commits captured by the host. The host may
/// read and hash bytes into CAS, but it never writes workspace source rows on
/// the Rust route; this helper is deliberately language-neutral and runs in
/// the same transaction as structural publication.
fn apply_source_index_commits(
    transaction: &Transaction<'_>,
    workspace_id: &str,
    commits: Option<&Value>,
    finalize_state: bool,
) -> Result<bool, CoreError> {
    let Some(commits) = commits.and_then(Value::as_array) else {
        return Ok(false);
    };
    let mut expected_revision: Option<i64> = None;
    let mut previous_state_revision: Option<i64> = None;
    let mut final_state: Option<&Value> = None;
    for commit in commits {
        let state = commit
            .get("state")
            .ok_or_else(|| CoreError("source commit state is missing".into()))?;
        let batch = commit
            .get("batch")
            .ok_or_else(|| CoreError("source commit batch is missing".into()))?;
        if value_string(state, "workspace_id")? != workspace_id
            || value_string(batch, "workspace_id")? != workspace_id
        {
            return Err(CoreError("source commit workspace mismatch".into()));
        }
        transaction.execute(
            "INSERT OR IGNORE INTO source_observation_batches (observation_batch_id, workspace_id, source_provider_binding_id, source_provider, source_provider_version, ordering_domain, observation_mode, coverage_scopes, coverage_completeness, deletion_authority, provider_cursor_before, provider_cursor_after, started_at, completed_at, observation_count, unavailable_count, batch_digest) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)",
            params![value_string(batch, "observation_batch_id")?, workspace_id, value_string(batch, "source_provider_binding_id")?, value_string(batch, "source_provider")?, value_string(batch, "source_provider_version")?, value_string(batch, "ordering_domain")?, value_string(batch, "observation_mode")?, value_string(batch, "coverage_scopes")?, value_string(batch, "coverage_completeness")?, value_string(batch, "deletion_authority")?, value_optional_string(batch, "provider_cursor_before"), value_optional_string(batch, "provider_cursor_after"), value_string(batch, "started_at")?, value_string(batch, "completed_at")?, batch.get("observation_count").and_then(Value::as_i64).ok_or_else(|| CoreError("source batch observation_count is missing".into()))?, batch.get("unavailable_count").and_then(Value::as_i64).ok_or_else(|| CoreError("source batch unavailable_count is missing".into()))?, value_string(batch, "batch_digest")?],
        ).map_err(sql_error)?;
        for artifact in commit
            .get("artifacts")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            if value_string(artifact, "workspace_id")? != workspace_id {
                return Err(CoreError("source artifact workspace mismatch".into()));
            }
            transaction.execute("INSERT OR IGNORE INTO source_artifacts (artifact_id, workspace_id, normalized_uri, normalized_path, display_path, artifact_kind) VALUES (?1, ?2, ?3, ?4, ?5, ?6)", params![value_string(artifact, "artifact_id")?, workspace_id, value_string(artifact, "normalized_uri")?, value_optional_string(artifact, "normalized_path"), value_optional_string(artifact, "display_path"), value_string(artifact, "artifact_kind")?]).map_err(sql_error)?;
        }
        for content in commit
            .get("content_blobs")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            transaction.execute("INSERT OR IGNORE INTO content_blobs (content_blob_id, content_hash, byte_length, storage_reference) VALUES (?1, ?2, ?3, ?4)", params![value_string(content, "content_blob_id")?, value_string(content, "content_hash")?, content.get("byte_length").and_then(Value::as_i64).ok_or_else(|| CoreError("source content byte_length is missing".into()))?, value_string(content, "storage_reference")?]).map_err(sql_error)?;
        }
        for observation in commit
            .get("observations")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            transaction.execute("INSERT OR IGNORE INTO source_observations (source_observation_id, observation_batch_id, workspace_id, artifact_id, source_provider_binding_id, source_provider, source_provider_version, ordering_domain, observation_mode, observed_state, observed_content_hash, observed_metadata_digest, provider_event_token, provider_sequence, observed_at, received_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)", params![value_string(observation, "source_observation_id")?, value_string(observation, "observation_batch_id")?, workspace_id, value_string(observation, "artifact_id")?, value_string(observation, "source_provider_binding_id")?, value_string(observation, "source_provider")?, value_string(observation, "source_provider_version")?, value_string(observation, "ordering_domain")?, value_string(observation, "observation_mode")?, value_string(observation, "observed_state")?, value_optional_string(observation, "observed_content_hash"), value_optional_string(observation, "observed_metadata_digest"), value_optional_string(observation, "provider_event_token"), value_optional_string(observation, "provider_sequence"), value_string(observation, "observed_at")?, value_string(observation, "received_at")?]).map_err(sql_error)?;
        }
        for version in commit
            .get("version_closures")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            transaction.execute("UPDATE artifact_versions SET valid_to_generation = ?1 WHERE workspace_id = ?2 AND artifact_version_id = ?3 AND valid_to_generation IS NULL", params![version.get("valid_to_generation").and_then(Value::as_i64), workspace_id, value_string(version, "artifact_version_id")?]).map_err(sql_error)?;
        }
        for version in commit
            .get("versions")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            if value_string(version, "workspace_id")? != workspace_id {
                return Err(CoreError("source version workspace mismatch".into()));
            }
            transaction.execute("INSERT INTO artifact_versions (artifact_version_id, workspace_id, artifact_id, content_blob_id, content_hash, byte_length, encoding, language_hint, analysis_metadata_digest, created_from_observation_id, valid_from_generation, valid_to_generation) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)", params![value_string(version, "artifact_version_id")?, workspace_id, value_string(version, "artifact_id")?, value_string(version, "content_blob_id")?, value_string(version, "content_hash")?, version.get("byte_length").and_then(Value::as_i64).ok_or_else(|| CoreError("source version byte_length is missing".into()))?, value_string(version, "encoding")?, value_optional_string(version, "language_hint"), value_string(version, "analysis_metadata_digest")?, value_string(version, "created_from_observation_id")?, version.get("valid_from_generation").and_then(Value::as_i64).ok_or_else(|| CoreError("source version valid_from_generation is missing".into()))?, version.get("valid_to_generation").and_then(Value::as_i64)]).map_err(sql_error)?;
        }
        for tombstone in commit
            .get("tombstone_closures")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            transaction.execute("UPDATE artifact_tombstones SET valid_to_generation = ?1, closing_artifact_change_id = ?2, replacement_artifact_version_id = ?3 WHERE workspace_id = ?4 AND artifact_tombstone_id = ?5 AND valid_to_generation IS NULL", params![tombstone.get("valid_to_generation").and_then(Value::as_i64), value_optional_string(tombstone, "closing_artifact_change_id"), value_optional_string(tombstone, "replacement_artifact_version_id"), workspace_id, value_string(tombstone, "artifact_tombstone_id")?]).map_err(sql_error)?;
        }
        for tombstone in commit
            .get("tombstones")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            if value_string(tombstone, "workspace_id")? != workspace_id {
                return Err(CoreError("source tombstone workspace mismatch".into()));
            }
            transaction.execute("INSERT INTO artifact_tombstones (artifact_tombstone_id, workspace_id, artifact_id, absence_kind, absence_reason_code, last_artifact_version_id, valid_from_generation, valid_to_generation, opening_artifact_change_id, closing_artifact_change_id, replacement_artifact_version_id, cause_references, lineage_evidence_record_ids) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)", params![value_string(tombstone, "artifact_tombstone_id")?, workspace_id, value_string(tombstone, "artifact_id")?, value_string(tombstone, "absence_kind")?, value_string(tombstone, "absence_reason_code")?, value_string(tombstone, "last_artifact_version_id")?, tombstone.get("valid_from_generation").and_then(Value::as_i64).ok_or_else(|| CoreError("source tombstone valid_from_generation is missing".into()))?, tombstone.get("valid_to_generation").and_then(Value::as_i64), value_string(tombstone, "opening_artifact_change_id")?, value_optional_string(tombstone, "closing_artifact_change_id"), value_optional_string(tombstone, "replacement_artifact_version_id"), value_string(tombstone, "cause_references")?, value_string(tombstone, "lineage_evidence_record_ids")?]).map_err(sql_error)?;
        }
        let commit_expected_revision = commit
            .get("expected_state_revision")
            .and_then(Value::as_i64)
            .ok_or_else(|| CoreError("source commit expected_state_revision is missing".into()))?;
        let state_revision = state
            .get("state_revision")
            .and_then(Value::as_i64)
            .ok_or_else(|| CoreError("source state state_revision is missing".into()))?;
        if let Some(first) = expected_revision {
            // A single capture normally emits all commits from one frontier
            // (the watch and enumerate paths both observe the same prior
            // state). A future engine may instead chain commits locally; in
            // that case each next expected revision must equal the preceding
            // commit's resulting revision. Both forms are folded into one
            // SQLite state update below.
            if commit_expected_revision != first
                && Some(commit_expected_revision) != previous_state_revision
            {
                return Err(CoreError(
                    "source commit state revisions are not a single or chained frontier".into(),
                ));
            }
        } else {
            expected_revision = Some(commit_expected_revision);
        }
        previous_state_revision = Some(state_revision);
        final_state = Some(state);
    }
    let Some(state) = final_state else {
        return Ok(false);
    };
    if !finalize_state {
        return Ok(true);
    }
    let expected_revision =
        expected_revision.expect("source commit state revision is present when state is present");
    let updated = transaction.execute("UPDATE source_index_state SET current_generation = ?1, state_revision = ?2, checkpoint_id = ?3, provider_watermarks = ?4, source_state_digest = ?5, updated_at = ?6 WHERE workspace_id = ?7 AND state_revision = ?8", params![state.get("current_generation").and_then(Value::as_i64).ok_or_else(|| CoreError("source state current_generation is missing".into()))?, state.get("state_revision").and_then(Value::as_i64).ok_or_else(|| CoreError("source state state_revision is missing".into()))?, value_string(state, "checkpoint_id")?, value_string(state, "provider_watermarks")?, value_string(state, "source_state_digest")?, value_string(state, "updated_at")?, workspace_id, expected_revision]).map_err(sql_error)?;
    let inserted = if expected_revision == 0 {
        transaction.execute("INSERT INTO source_index_state (workspace_id, current_generation, state_revision, checkpoint_id, provider_watermarks, source_state_digest, updated_at) SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7 WHERE ?8 = 0 AND NOT EXISTS (SELECT 1 FROM source_index_state WHERE workspace_id = ?1)", params![workspace_id, state.get("current_generation").and_then(Value::as_i64).unwrap_or(0), state.get("state_revision").and_then(Value::as_i64).unwrap_or(0), value_string(state, "checkpoint_id")?, value_string(state, "provider_watermarks")?, value_string(state, "source_state_digest")?, value_string(state, "updated_at")?, expected_revision]).map_err(sql_error)?
    } else {
        0
    };
    if updated + inserted != 1 {
        return Err(CoreError(format!(
            "source index state revision conflict (expected {expected_revision})"
        )));
    }
    Ok(true)
}

/// Remove a failed first-generation source layer. Fork recovery deliberately
/// targets a newly registered workspace, so deleting its source frontier is
/// safe and restores the empty pre-scan state before retrying.
fn rollback_source_index(
    transaction: &Transaction<'_>,
    workspace_id: &str,
) -> Result<(), CoreError> {
    for sql in [
        "DELETE FROM artifact_tombstones WHERE workspace_id = ?1",
        "DELETE FROM artifact_versions WHERE workspace_id = ?1",
        "DELETE FROM source_observations WHERE workspace_id = ?1",
        "DELETE FROM source_observation_batches WHERE workspace_id = ?1",
        "DELETE FROM source_artifacts WHERE workspace_id = ?1",
        "DELETE FROM source_index_state WHERE workspace_id = ?1",
    ] {
        transaction
            .execute(sql, params![workspace_id])
            .map_err(sql_error)?;
    }
    Ok(())
}

fn digest_envelope(domain: &str, recipe: &str, schema: &str, payload: &Value) -> String {
    json_digest(&serde_json::json!([
        "urdira", 1, domain, recipe, 1, schema, 1, "sha256", payload
    ]))
}

fn descriptor(kind: &str, count: i64, digest: &str) -> String {
    // Use the JSON encoder for the two dynamic fields. `Debug` formatting is
    // equivalent for today's ASCII identifiers but would emit invalid JSON
    // if a future closed value ever contains a quote or control byte.
    let kind_json = serde_json::to_string(kind).unwrap_or_else(|_| "\"\"".into());
    let digest_json = serde_json::to_string(digest).unwrap_or_else(|_| "\"\"".into());
    format!(
        "{{\"change_set_kind\":{kind_json},\"entry_schema_version\":\"1\",\"comparator_id\":\"core:lexicographic_uri\",\"comparator_version\":\"1\",\"entry_count\":{count},\"content_digest\":{digest_json}}}"
    )
}

fn ordered_projection_set_json(entries: &Value) -> String {
    let Some(values) = entries.as_array() else {
        return "[]".into();
    };
    let rows = values.iter().map(|entry| {
        format!("{{\"projection_kind\":{},\"generator\":{},\"generator_version\":{},\"generator_configuration_digest\":{},\"projection_set_digest\":{}}}",
            serde_json::to_string(entry.get("projection_kind").unwrap_or(&Value::Null)).unwrap_or_else(|_| "null".into()),
            serde_json::to_string(entry.get("generator").unwrap_or(&Value::Null)).unwrap_or_else(|_| "null".into()),
            serde_json::to_string(entry.get("generator_version").unwrap_or(&Value::Null)).unwrap_or_else(|_| "null".into()),
            serde_json::to_string(entry.get("generator_configuration_digest").unwrap_or(&Value::Null)).unwrap_or_else(|_| "null".into()),
            serde_json::to_string(entry.get("projection_set_digest").unwrap_or(&Value::Null)).unwrap_or_else(|_| "null".into()))
    }).collect::<Vec<_>>();
    format!("[{}]", rows.join(","))
}

/// Rebuilds the source transition templates from the generic capture commits.
/// The TypeScript source planner remains an oracle for compatibility callers,
/// but production Rust publication must not receive a second owner-sized copy
/// of the same versions/tombstones.  Commit payloads are already the canonical
/// source authority, so deriving this bounded metadata here preserves the
/// transition IDs and digests while keeping the application wire envelope
/// compact.
fn derive_source_transitions(
    transaction: &Transaction<'_>,
    workspace_id: &str,
    commits: Option<&Value>,
) -> Result<Option<Value>, CoreError> {
    let Some(commits) = commits.and_then(Value::as_array) else {
        return Ok(None);
    };
    if commits.is_empty() {
        return Ok(Some(Value::Array(Vec::new())));
    }
    let mut previous_versions = HashMap::<String, (String, String, String)>::new();
    let mut previous_tombstones = HashMap::<String, (String, String)>::new();
    {
        let mut statement = transaction
            .prepare("SELECT artifact_id, artifact_version_id, content_hash, analysis_metadata_digest FROM artifact_versions WHERE workspace_id = ?1 AND valid_to_generation IS NULL")
            .map_err(sql_error)?;
        let rows = statement
            .query_map([workspace_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                ))
            })
            .map_err(sql_error)?;
        for row in rows {
            let (artifact_id, version_id, hash, analysis_digest) = row.map_err(sql_error)?;
            previous_versions.insert(artifact_id, (version_id, hash, analysis_digest));
        }
        let mut statement = transaction
            .prepare("SELECT artifact_id, artifact_tombstone_id, absence_kind FROM artifact_tombstones WHERE workspace_id = ?1 AND valid_to_generation IS NULL")
            .map_err(sql_error)?;
        let rows = statement
            .query_map([workspace_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })
            .map_err(sql_error)?;
        for row in rows {
            let (artifact_id, tombstone_id, absence_kind) = row.map_err(sql_error)?;
            previous_tombstones.insert(artifact_id, (tombstone_id, absence_kind));
        }
    }
    let mut transitions = Vec::new();
    for commit in commits {
        let batch_id = value_string(
            commit.get("batch").unwrap_or(&Value::Null),
            "observation_batch_id",
        )?;
        for version in commit
            .get("versions")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let artifact_id = value_string(version, "artifact_id")?;
            let observation_id = value_string(version, "created_from_observation_id")?;
            let previous = previous_versions.get(&artifact_id).cloned();
            let previous_tombstone = previous_tombstones.get(&artifact_id).cloned();
            let change_kind = if let Some((_, absence_kind)) = previous_tombstone.as_ref() {
                if absence_kind == "excluded" {
                    "reincluded"
                } else {
                    "recreated"
                }
            } else if previous.is_some() {
                "updated"
            } else {
                "created"
            };
            let change_id = stable_id(
                "artifact-change",
                &serde_json::json!({ "kind": change_kind, "batch_id": batch_id, "artifact_id": artifact_id }),
            );
            let mut target_version = version.clone();
            if let Some(object) = target_version.as_object_mut() {
                object.remove("valid_from_generation");
                object.remove("valid_to_generation");
            }
            let cause = serde_json::json!([{ "cause_type": "source_observation", "cause_id": observation_id }]);
            let mut change = serde_json::Map::new();
            change.insert("artifact_change_id".into(), Value::String(change_id));
            change.insert("workspace_id".into(), Value::String(workspace_id.into()));
            change.insert("artifact_id".into(), Value::String(artifact_id.clone()));
            change.insert("change_kind".into(), Value::String(change_kind.into()));
            if let Some((version_id, _, _)) = previous {
                change.insert(
                    "previous_artifact_version_id".into(),
                    Value::String(version_id),
                );
            }
            change.insert(
                "new_artifact_version_id".into(),
                Value::String(value_string(version, "artifact_version_id")?),
            );
            if let Some((tombstone_id, _)) = previous_tombstone {
                change.insert("previous_tombstone_id".into(), Value::String(tombstone_id));
            }
            change.insert("cause_references".into(), cause.clone());
            change.insert(
                "lineage_evidence_record_ids".into(),
                Value::Array(Vec::new()),
            );
            transitions.push(serde_json::json!({
                "artifact_change": Value::Object(change),
                "target_artifact_version_without_generation": target_version,
            }));
            previous_versions.insert(
                artifact_id.clone(),
                (
                    value_string(version, "artifact_version_id")?,
                    value_string(version, "content_hash")?,
                    value_string(version, "analysis_metadata_digest")?,
                ),
            );
            previous_tombstones.remove(&artifact_id);
        }
        for tombstone in commit
            .get("tombstones")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let artifact_id = value_string(tombstone, "artifact_id")?;
            let absence_kind = value_string(tombstone, "absence_kind")?;
            let previous = previous_versions.remove(&artifact_id).ok_or_else(|| {
                CoreError("source tombstone has no prior artifact version".into())
            })?;
            let change_id = stable_id(
                "artifact-change",
                &serde_json::json!({ "kind": absence_kind, "batch_id": batch_id, "artifact_id": artifact_id }),
            );
            let tombstone_id = value_string(tombstone, "artifact_tombstone_id")?;
            let cause = tombstone
                .get("cause_references")
                .and_then(Value::as_str)
                .and_then(|text| serde_json::from_str::<Value>(text).ok())
                .unwrap_or_else(|| Value::Array(Vec::new()));
            let mut target_tombstone = tombstone.clone();
            if let Some(object) = target_tombstone.as_object_mut() {
                object.remove("valid_from_generation");
                object.remove("valid_to_generation");
                object.remove("closing_artifact_change_id");
                object.remove("replacement_artifact_version_id");
            }
            let change = serde_json::json!({
                "artifact_change_id": change_id,
                "workspace_id": workspace_id,
                "artifact_id": artifact_id,
                "change_kind": absence_kind,
                "previous_artifact_version_id": previous.0,
                "new_tombstone_id": tombstone_id,
                "cause_references": cause,
                "lineage_evidence_record_ids": [],
            });
            transitions.push(serde_json::json!({
                "artifact_change": change,
                "target_artifact_tombstone_without_generation": target_tombstone,
            }));
            previous_tombstones.insert(artifact_id, (tombstone_id, absence_kind));
        }
    }
    Ok(Some(Value::Array(transitions)))
}

/// Final v3 publication owned by the Rust runtime. The envelope contains only
/// bounded candidate/control metadata; all structural rows are read from the
/// Rust-owned candidate publication relation and installed set-wise here.
fn finalize_workspace_publication(
    transaction: &Transaction<'_>,
    request: &GenerationRequest,
    publication: &Value,
) -> Result<(), CoreError> {
    let publish_started = Instant::now();
    let candidate = publication
        .get("candidate")
        .ok_or_else(|| CoreError("publication candidate is missing".into()))?;
    let derived_source_transitions = derive_source_transitions(
        transaction,
        &request.workspace_id,
        publication.get("source_index_commits"),
    )?;
    // Rust-owned generations do not carry a TypeScript materialization across
    // the process boundary. Build the compact control descriptor here from
    // the already-staged transition metadata and capability state. This is
    // intentionally the same UCE object shape as the former TS placeholder,
    // but it is now sealed and persisted by the writer that owns publication.
    let materialization = publication.get("materialization").cloned().unwrap_or_else(|| {
        let transitions = derived_source_transitions
            .as_ref()
            .and_then(Value::as_array)
            .cloned()
            .or_else(|| publication.get("source_transitions").and_then(Value::as_array).cloned())
            .unwrap_or_default();
        let ordered_set = |element_type: &str, entries: &[Value]| {
            let content_digest = canonical_array_digest(entries);
            serde_json::json!({
                "descriptor_id": format!("set:{}", content_digest.trim_start_matches("sha256:")),
                "element_type": element_type,
                "element_schema_version": "1",
                "comparator_id": "core:lexicographic_uri",
                "comparator_version": "1",
                "entry_count": entries.len(),
                "content_digest": content_digest,
            })
            .to_string()
        };
        let empty: Vec<Value> = Vec::new();
        let core = serde_json::json!({
            "workspace_id": request.workspace_id,
            "candidate_generation_id": request.candidate_generation_id,
            "accepted_fact_delta_digests": [],
            "source_transition_template_set": ordered_set("core:CandidateSourceTransitionTemplate", &transitions),
            "record_open_template_set": ordered_set("core:CandidateRecordOpenTemplate", &empty),
            "record_closure_template_set": ordered_set("core:CandidateRecordClosureTemplate", &empty),
            "identity_assignment_template_set": ordered_set("core:CandidateIdentityAssignmentTemplate", &empty),
            "projection_open_template_sets": [],
            "projection_closure_template_sets": [],
            "capability_state_entries": publication.get("capability_state_entries").cloned().unwrap_or_else(|| Value::Array(Vec::new())),
            "source_observation_watermarks": [],
            "artifact_dependency_template_set": ordered_set("core:RecordArtifactDependency", &empty),
            "lookup_dependency_template_set": ordered_set("core:PluginLookupInvalidationDependency", &empty),
            "lookup_revalidation_template_set": ordered_set("core:LookupRevalidationTemplate", &empty),
        });
        let digest = json_digest(&core);
        let mut object = core.as_object().cloned().unwrap_or_default();
        object.insert("candidate_materialization_id".into(), Value::String(format!("materialization:{}", digest.trim_start_matches("sha256:"))));
        object.insert("materialization_digest".into(), Value::String(digest));
        Value::Object(object)
    });
    let registry = publication
        .get("target_registry")
        .ok_or_else(|| CoreError("publication registry is missing".into()))?;
    let lock = publication
        .get("target_resolution_lock")
        .ok_or_else(|| CoreError("publication resolution lock is missing".into()))?;
    let configuration = publication
        .get("target_configuration")
        .ok_or_else(|| CoreError("publication configuration is missing".into()))?;
    let freshness = publication
        .get("freshness_checkpoint")
        .ok_or_else(|| CoreError("publication freshness checkpoint is missing".into()))?;
    let published_at = value_optional_string(publication, "published_at")
        .unwrap_or_else(|| request.operation_id.clone());
    let snapshot_id = format!("snapshot:{}", request.candidate_generation_id);
    let manifest_id = format!("generation-manifest:{}", request.candidate_generation_id);
    let generation: i64 = transaction
        .query_row(
            "SELECT MAX(value) FROM (SELECT COALESCE(MAX(current_generation) + 1, 1) AS value FROM workspace_current_state WHERE workspace_id = ?1 UNION ALL SELECT COALESCE(MAX(current_generation), 0) FROM source_index_state WHERE workspace_id = ?1)",
            [&request.workspace_id],
            |row| row.get(0),
        )
        .map_err(sql_error)?;
    let source_commits_applied = apply_source_index_commits(
        transaction,
        &request.workspace_id,
        publication.get("source_index_commits"),
        true,
    )?;
    if !source_commits_applied {
        apply_source_transitions(
            transaction,
            &request.workspace_id,
            generation,
            derived_source_transitions
                .as_ref()
                .or_else(|| publication.get("source_transitions")),
        )?;
    }
    debug_publish_phase(publish_started, "source_transitions");

    transaction
        .execute(
            "INSERT INTO registry_snapshots (registry_snapshot_id, workspace_id, registry_contract_version, core_registry_digest, resolution_lock_id, registry_digest) VALUES (?1, ?2, ?3, ?4, ?5, ?6) ON CONFLICT(registry_snapshot_id) DO NOTHING",
            params![
                value_string(registry, "registry_snapshot_id")?,
                &request.workspace_id,
                value_string(registry, "registry_contract_version")?,
                value_string(registry, "core_registry_digest")?,
                value_string(lock, "resolution_lock_id")?,
                value_string(registry, "registry_digest")?,
            ],
        )
        .map_err(sql_error)?;
    let lock_id = value_string(lock, "resolution_lock_id")?;
    let config_id = value_string(configuration, "configuration_revision_id")?;
    let freshness_id = value_string(freshness, "freshness_checkpoint_id")?;
    let freshness_reference_snapshot = publication
        .get("source_snapshot_id")
        .and_then(Value::as_str)
        .or_else(|| freshness.get("snapshot_id").and_then(Value::as_str))
        .unwrap_or(&snapshot_id);
    for (key, kind, state, reference_snapshot, source_digest) in [
        (
            format!("plugin_resolution_lock:{lock_id}"),
            "plugin_resolution_lock",
            lock,
            None,
            None,
        ),
        (
            format!("workspace_configuration_revision:{config_id}"),
            "workspace_configuration_revision",
            configuration,
            None,
            None,
        ),
        (
            format!("workspace_freshness_checkpoint:{freshness_id}"),
            "workspace_freshness_checkpoint",
            freshness,
            Some(freshness_reference_snapshot),
            Some(request.source_state_digest.as_str()),
        ),
    ] {
        transaction
            .execute(
                "INSERT INTO control_plane_state (state_key, workspace_id, state_kind, state_json, reference_workspace_id, reference_snapshot_id, reference_source_state_digest, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8) ON CONFLICT(state_key) DO NOTHING",
                params![key, &request.workspace_id, kind, json_text(state), if reference_snapshot.is_some() { Some(request.workspace_id.as_str()) } else { None }, reference_snapshot, source_digest, &published_at],
            )
        .map_err(sql_error)?;
    }
    if let Some(capabilities) = materialization
        .get("capability_state_entries")
        .and_then(Value::as_array)
    {
        for capability in capabilities {
            let digest = json_digest(capability);
            let key = format!(
                "capability_state:{}:{}",
                request.candidate_generation_id, digest
            );
            transaction
                .execute(
                    "INSERT INTO control_plane_state (state_key, workspace_id, state_kind, state_json, reference_workspace_id, reference_snapshot_id, reference_source_state_digest, updated_at) VALUES (?1, ?2, 'capability_state', ?3, ?2, NULL, NULL, ?4) ON CONFLICT(state_key) DO NOTHING",
                    params![key, &request.workspace_id, json_text(capability), &published_at],
                )
                .map_err(sql_error)?;
        }
    }
    if let Some(lookups) = publication.get("lookup_bindings").and_then(Value::as_array) {
        for value in lookups {
            let Some(object) = value.as_object() else {
                continue;
            };
            let Some(lookup_id) = object.get("lookup_dependency_id").and_then(Value::as_str) else {
                continue;
            };
            let string = |key: &str, fallback: &str| {
                object
                    .get(key)
                    .and_then(Value::as_str)
                    .unwrap_or(fallback)
                    .to_owned()
            };
            let normalized = string("normalized_selector_or_address", "");
            let selector_digest = string("selector_digest", "");
            let selector_digest = if selector_digest.is_empty() {
                json_digest(&Value::String(normalized.clone()))
            } else {
                selector_digest
            };
            let dependency_digest = object
                .get("dependency_digest")
                .and_then(Value::as_str)
                .map(str::to_owned)
                .unwrap_or_else(|| logical_digest(value, "urdira:lookup-dependency:v2"));
            transaction
                .execute(
                    "INSERT INTO candidate_lookup_dependencies (lookup_dependency_id, workspace_id, candidate_generation_id, consumer_type, consumer_id, owner_artifact_id, owner_artifact_version_id, operation, normalized_selector_or_address, selector_digest, previous_result_set_digest, invalidation_scope, valid_from_generation, valid_to_generation, dependency_digest) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, NULL, ?14) ON CONFLICT(lookup_dependency_id) DO UPDATE SET dependency_digest = excluded.dependency_digest WHERE candidate_lookup_dependencies.workspace_id = excluded.workspace_id AND candidate_lookup_dependencies.candidate_generation_id = excluded.candidate_generation_id AND candidate_lookup_dependencies.consumer_type = excluded.consumer_type AND candidate_lookup_dependencies.consumer_id = excluded.consumer_id AND candidate_lookup_dependencies.owner_artifact_id IS excluded.owner_artifact_id AND candidate_lookup_dependencies.owner_artifact_version_id IS excluded.owner_artifact_version_id AND candidate_lookup_dependencies.operation = excluded.operation AND candidate_lookup_dependencies.normalized_selector_or_address = excluded.normalized_selector_or_address AND candidate_lookup_dependencies.selector_digest = excluded.selector_digest AND candidate_lookup_dependencies.previous_result_set_digest = excluded.previous_result_set_digest AND candidate_lookup_dependencies.invalidation_scope = excluded.invalidation_scope AND candidate_lookup_dependencies.valid_from_generation = excluded.valid_from_generation AND candidate_lookup_dependencies.valid_to_generation IS excluded.valid_to_generation",
                    params![
                        lookup_id,
                        &request.workspace_id,
                        &request.candidate_generation_id,
                        string("consumer_type", "unknown"),
                        string("consumer_id", ""),
                        object.get("owner_artifact_id").and_then(Value::as_str),
                        object
                            .get("owner_artifact_version_id")
                            .and_then(Value::as_str),
                        string("operation", "lookup"),
                        normalized,
                        selector_digest,
                        string("previous_result_set_digest", ""),
                        string("invalidation_scope", "candidate"),
                        generation,
                        dependency_digest,
                    ],
                )
                .map_err(sql_error)?;
        }
    }
    debug_publish_phase(publish_started, "control_plane");
    if let Some(revalidations) = publication
        .get("lookup_revalidations")
        .and_then(Value::as_array)
    {
        for value in revalidations {
            let id = value
                .get("lookup_dependency_id")
                .and_then(Value::as_str)
                .map(str::to_owned)
                .unwrap_or_else(|| json_digest(value));
            let state = if let Some(object) = value.as_object() {
                let mut object = object.clone();
                object.insert(
                    "candidate_generation_id".into(),
                    Value::String(request.candidate_generation_id.clone()),
                );
                object.insert(
                    "valid_from_generation".into(),
                    Value::Number(generation.into()),
                );
                Value::Object(object)
            } else {
                value.clone()
            };
            transaction.execute("INSERT INTO control_plane_state (state_key, workspace_id, state_kind, state_json, reference_workspace_id, reference_snapshot_id, reference_source_state_digest, updated_at) VALUES (?1, ?2, 'lookup_revalidation', ?3, ?2, NULL, NULL, ?4) ON CONFLICT(state_key) DO NOTHING", params![format!("lookup_revalidation:{}:{}", request.candidate_generation_id, id), &request.workspace_id, json_text(&state), &published_at]).map_err(sql_error)?;
        }
    }

    let descriptor_row: (i64, i64, i64, i64, Option<String>, Option<String>, String, String) = transaction
        .query_row(
            "SELECT record_count, facet_count, identity_count, canonical_byte_length, first_record_id, last_record_id, record_sequence_digest, identity_sequence_digest FROM candidate_publication_descriptors WHERE candidate_generation_id = ?1 AND workspace_id = ?2",
            [&request.candidate_generation_id, &request.workspace_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?, row.get(6)?, row.get(7)?)),
        )
        .map_err(sql_error)?;
    let record_count = descriptor_row.0;
    let identity_count = descriptor_row.2;
    // The sealed materialization already carries the exact canonical-array
    // digests. Reusing those descriptors keeps Rust and the TS oracle
    // byte-identical without rebuilding per-owner template arrays.
    let materialization_object = materialization.as_object();
    let descriptor_digest = |field: &str, fallback: String| -> String {
        materialization_object
            .and_then(|object| object.get(field))
            .and_then(Value::as_str)
            .and_then(|text| serde_json::from_str::<Value>(text).ok())
            .and_then(|value| {
                value
                    .get("content_digest")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            })
            .unwrap_or(fallback)
    };
    let record_sequence_digest = if descriptor_row.6 == "rust:pending" {
        descriptor_digest("record_open_template_set", descriptor_row.6.clone())
    } else {
        descriptor_row.6.clone()
    };
    let identity_sequence_digest = if descriptor_row.7 == "rust:pending" {
        descriptor_digest("identity_assignment_template_set", descriptor_row.7.clone())
    } else {
        descriptor_row.7.clone()
    };
    debug_publish_phase(publish_started, "promo_descriptor_read");
    transaction.execute("UPDATE candidate_publication_record_occurrences SET valid_from_generation = ?1 WHERE candidate_generation_id = ?2", params![generation, &request.candidate_generation_id]).map_err(sql_error)?;
    debug_publish_phase(publish_started, "promo_update_cpro");
    transaction.execute("UPDATE candidate_publication_record_facets SET valid_from_generation = ?1 WHERE candidate_generation_id = ?2", params![generation, &request.candidate_generation_id]).map_err(sql_error)?;
    debug_publish_phase(publish_started, "promo_update_facets");
    transaction.execute("UPDATE candidate_publication_identity_assignments SET valid_from_generation = ?1 WHERE candidate_generation_id = ?2", params![generation, &request.candidate_generation_id]).map_err(sql_error)?;
    debug_publish_phase(publish_started, "promo_update_ident");
    transaction.execute("UPDATE candidate_publication_record_closures SET valid_to_generation = ?1 WHERE candidate_generation_id = ?2", params![generation, &request.candidate_generation_id]).map_err(sql_error)?;
    debug_publish_phase(publish_started, "promo_update_closures_vf");
    transaction.execute("UPDATE candidate_publication_descriptors SET record_sequence_digest = ?1, identity_sequence_digest = ?2, sealed_at = ?3 WHERE candidate_generation_id = ?4", params![record_sequence_digest, identity_sequence_digest, &published_at, &request.candidate_generation_id]).map_err(sql_error)?;
    debug_publish_phase(publish_started, "promo_update_descriptors");

    // A cold workspace has no published structural rows. Avoid paying the
    // per-row uniqueness probe for that common path, while retaining the
    // idempotent conflict-safe statement for replay/incremental generations.
    let records_exist: bool = transaction
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM record_occurrences WHERE workspace_id = ?1 LIMIT 1)",
            [&request.workspace_id],
            |row| row.get(0),
        )
        .map_err(sql_error)?;
    // A cold direct publication inserts a large append-only set. The lookup
    // indexes are empty at this point, so maintaining them row by row is pure
    // write amplification. Drop only the rebuildable secondary indexes inside
    // the same transaction and recreate them before commit; readers never
    // observe the intermediate schema and rollback restores the prior state.
    //
    // Safety invariant: SQLite indexes are scoped to the whole table they
    // index, not to a single workspace's rows within it, but each workspace
    // owns its own SQLite *file* -- `DurableStorage.registerWorkspace`
    // resolves every workspace to its own path via `defaultWorkspacePath`
    // (packages/storage/src/storage.ts:377) and a fork copies its donor into
    // its own separate file over an `ATTACH DATABASE ... AS fork_donor_db`
    // (packages/engine/src/workspace-fork.ts:750), never sharing a file with
    // the donor. A single connection/transaction, and therefore a single
    // DROP/CREATE INDEX pair, is consequently already scoped to exactly one
    // workspace's tables, so dropping and recreating an accelerator index
    // during this workspace's cold commit can never observe or affect
    // another workspace's rows. If a future change ever puts more than one
    // workspace's rows in the same SQLite file (shared-table
    // multi-tenancy), this DROP/CREATE dance would need to move to a
    // per-workspace-filtered rebuild instead -- it is only sound today
    // because "one file per workspace" holds.
    let cold_direct = request.direct_publication && !records_exist;
    if cold_direct {
        transaction
            .execute_batch(
                "DROP INDEX IF EXISTS record_occurrences_visible_idx; DROP INDEX IF EXISTS record_occurrences_digest_order_idx; DROP INDEX IF EXISTS record_occurrences_workspace_owner_idx; DROP INDEX IF EXISTS record_occurrences_workspace_owner_version_idx;",
            )
            .map_err(sql_error)?;
    }
    debug_publish_phase(publish_started, "promo_records_exist_probe");
    let record_insert_sql = if records_exist {
        "INSERT INTO record_occurrences (record_id, workspace_id, category, kind, universal_kind, schema_version, producer_id, producer_version, owner_artifact_id, owner_artifact_version_id, primary_source_span_artifact_version_id, primary_source_span_start_byte, primary_source_span_end_byte, primary_source_span_start_line, primary_source_span_end_line, valid_from_generation, valid_to_generation, record_digest, body_digest, body_byte_length, body_payload, analysis_digest, analysis_configuration_digest, artifact_dependency_digest) SELECT record_id, workspace_id, category, kind, universal_kind, schema_version, producer_id, producer_version, owner_artifact_id, owner_artifact_version_id, primary_source_span_artifact_version_id, primary_source_span_start_byte, primary_source_span_end_byte, primary_source_span_start_line, primary_source_span_end_line, valid_from_generation, NULL, record_digest, body_digest, body_byte_length, body_payload, analysis_digest, analysis_configuration_digest, artifact_dependency_digest FROM candidate_publication_record_occurrences WHERE candidate_generation_id = ?1 ORDER BY record_id ON CONFLICT(record_id) DO NOTHING"
    } else {
        "INSERT INTO record_occurrences (record_id, workspace_id, category, kind, universal_kind, schema_version, producer_id, producer_version, owner_artifact_id, owner_artifact_version_id, primary_source_span_artifact_version_id, primary_source_span_start_byte, primary_source_span_end_byte, primary_source_span_start_line, primary_source_span_end_line, valid_from_generation, valid_to_generation, record_digest, body_digest, body_byte_length, body_payload, analysis_digest, analysis_configuration_digest, artifact_dependency_digest) SELECT record_id, workspace_id, category, kind, universal_kind, schema_version, producer_id, producer_version, owner_artifact_id, owner_artifact_version_id, primary_source_span_artifact_version_id, primary_source_span_start_byte, primary_source_span_end_byte, primary_source_span_start_line, primary_source_span_end_line, valid_from_generation, NULL, record_digest, body_digest, body_byte_length, body_payload, analysis_digest, analysis_configuration_digest, artifact_dependency_digest FROM candidate_publication_record_occurrences WHERE candidate_generation_id = ?1 ORDER BY record_id"
    };
    if request.direct_publication {
        // Durable row order is not part of the v3 contract: every public
        // digest/query orders by its declared key. Keep the direct inserts
        // unordered so SQLite can stream the core TEMP relation without a
        // large publication sort; the compatibility candidate projection
        // below retains its explicit deterministic row ordinal.
        let direct_sql = if records_exist {
            "INSERT INTO record_occurrences (record_id, workspace_id, category, kind, universal_kind, schema_version, producer_id, producer_version, owner_artifact_id, owner_artifact_version_id, primary_source_span_artifact_version_id, primary_source_span_start_byte, primary_source_span_end_byte, primary_source_span_start_line, primary_source_span_end_line, valid_from_generation, valid_to_generation, record_digest, body_digest, body_byte_length, body_payload, analysis_digest, analysis_configuration_digest, artifact_dependency_digest) SELECT 'record:' || lower(hex(o.publication_record_id)), ?1, o.record_category, o.record_kind, o.record_universal_kind, o.record_schema_version, 'candidate', '1', o.owner_artifact_id, o.owner_artifact_version_id, o.primary_source_span_artifact_version_id, o.primary_source_span_start_byte, o.primary_source_span_end_byte, o.primary_source_span_start_line, o.primary_source_span_end_line, ?2, NULL, 'sha256:' || lower(hex(o.record_digest)), 'sha256:' || lower(hex(o.body_digest)), o.body_byte_length, o.body_payload_hex, ?2, ?2, ?2 FROM urdira_core_owner_rows o WHERE o.lane = 'records' ON CONFLICT(record_id) DO NOTHING"
        } else {
            "INSERT INTO record_occurrences (record_id, workspace_id, category, kind, universal_kind, schema_version, producer_id, producer_version, owner_artifact_id, owner_artifact_version_id, primary_source_span_artifact_version_id, primary_source_span_start_byte, primary_source_span_end_byte, primary_source_span_start_line, primary_source_span_end_line, valid_from_generation, valid_to_generation, record_digest, body_digest, body_byte_length, body_payload, analysis_digest, analysis_configuration_digest, artifact_dependency_digest) SELECT 'record:' || lower(hex(o.publication_record_id)), ?1, o.record_category, o.record_kind, o.record_universal_kind, o.record_schema_version, 'candidate', '1', o.owner_artifact_id, o.owner_artifact_version_id, o.primary_source_span_artifact_version_id, o.primary_source_span_start_byte, o.primary_source_span_end_byte, o.primary_source_span_start_line, o.primary_source_span_end_line, ?2, NULL, 'sha256:' || lower(hex(o.record_digest)), 'sha256:' || lower(hex(o.body_digest)), o.body_byte_length, o.body_payload_hex, ?2, ?2, ?2 FROM urdira_core_owner_rows o WHERE o.lane = 'records'"
        };
        if std::env::var_os("URDIRA_DEBUG_TIMING").is_some() {
            let staged_rows: i64 = transaction
                .query_row(
                    "SELECT COUNT(*) FROM urdira_core_owner_rows WHERE lane = 'records'",
                    [],
                    |row| row.get(0),
                )
                .map_err(sql_error)?;
            eprintln!("[urdira-indexing-worker] direct structural record rows={staged_rows}");
        }
        transaction
            .execute(direct_sql, params![&request.workspace_id, generation])
            .map_err(sql_error)?;
        debug_publish_phase(publish_started, "promo_record_insert");
        // The core staging relation has a primary key for every facet and a
        // cold workspace has no durable facet rows to conflict with. Avoid
        // probing the destination uniqueness index once on that hot path;
        // replay and incremental generations retain the idempotent branch.
        let facet_insert_sql = "INSERT INTO record_facets (workspace_id, record_id, valid_from_generation, facet_ordinal, facet) SELECT ?1, 'record:' || lower(hex(o.publication_record_id)), ?2, f.facet_ordinal, f.facet FROM urdira_core_owner_rows o JOIN urdira_core_owner_facets f ON f.owner_artifact_id = o.owner_artifact_id AND f.owner_artifact_version_id = o.owner_artifact_version_id AND f.observation_lane = o.observation_lane AND f.sequence = o.sequence AND f.row_ordinal = o.row_ordinal WHERE o.lane = 'records' ON CONFLICT DO NOTHING";
        transaction
            .execute(facet_insert_sql, params![&request.workspace_id, generation])
            .map_err(sql_error)?;
        debug_publish_phase(publish_started, "promo_facet_insert");
    } else {
        transaction
            .execute(record_insert_sql, [&request.candidate_generation_id])
            .map_err(sql_error)?;
        debug_publish_phase(publish_started, "promo_record_insert");
        transaction.execute("INSERT INTO record_facets (workspace_id, record_id, valid_from_generation, facet_ordinal, facet) SELECT workspace_id, record_id, valid_from_generation, facet_ordinal, facet FROM candidate_publication_record_facets WHERE candidate_generation_id = ?1 ORDER BY record_id, facet_ordinal ON CONFLICT DO NOTHING", [&request.candidate_generation_id]).map_err(sql_error)?;
        debug_publish_phase(publish_started, "promo_facet_insert");
    }
    transaction.execute("UPDATE record_occurrences SET valid_to_generation = ?1 WHERE workspace_id = ?2 AND valid_to_generation IS NULL AND record_id IN (SELECT record_id FROM candidate_publication_record_closures WHERE candidate_generation_id = ?3)", params![generation, &request.workspace_id, &request.candidate_generation_id]).map_err(sql_error)?;
    debug_publish_phase(publish_started, "promo_closures_update");
    let identities_exist: bool = transaction
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM identity_assignments WHERE workspace_id = ?1 LIMIT 1)",
            [&request.workspace_id],
            |row| row.get(0),
        )
        .map_err(sql_error)?;
    if cold_direct && !identities_exist {
        transaction
            .execute_batch(
                "DROP INDEX IF EXISTS identity_assignments_lookup_idx; DROP INDEX IF EXISTS identity_assignments_key_idx; DROP INDEX IF EXISTS identity_assignments_owner_key_idx; DROP INDEX IF EXISTS identity_assignments_record_idx;",
            )
            .map_err(sql_error)?;
    }
    debug_publish_phase(publish_started, "promo_identities_exist_probe");
    let identity_insert_sql = if identities_exist {
        "INSERT INTO identity_assignments (identity_assignment_id, workspace_id, identity_type, identity_id, assignment_kind, identity_key, identity_key_digest, record_id, previous_record_id, owner_artifact_id, owner_artifact_version_id, valid_from_generation, valid_to_generation) SELECT identity_assignment_id, workspace_id, identity_type, identity_id, assignment_kind, identity_key, identity_key_digest, record_id, previous_record_id, NULL, NULL, valid_from_generation, NULL FROM candidate_publication_identity_assignments WHERE candidate_generation_id = ?1 ORDER BY identity_assignment_id ON CONFLICT DO NOTHING"
    } else {
        "INSERT INTO identity_assignments (identity_assignment_id, workspace_id, identity_type, identity_id, assignment_kind, identity_key, identity_key_digest, record_id, previous_record_id, owner_artifact_id, owner_artifact_version_id, valid_from_generation, valid_to_generation) SELECT identity_assignment_id, workspace_id, identity_type, identity_id, assignment_kind, identity_key, identity_key_digest, record_id, previous_record_id, NULL, NULL, valid_from_generation, NULL FROM candidate_publication_identity_assignments WHERE candidate_generation_id = ?1 ORDER BY identity_assignment_id"
    };
    if request.direct_publication {
        let direct_identity_sql = if identities_exist {
            "WITH owner_keys AS (SELECT DISTINCT identity_type, identity_key FROM urdira_core_owner_rows WHERE lane = 'records' AND identity_type IS NOT NULL AND identity_key IS NOT NULL), previous_generation AS (SELECT ia.identity_type, ia.identity_key, MAX(ia.valid_from_generation) AS valid_from_generation FROM identity_assignments ia JOIN owner_keys k ON k.identity_type = ia.identity_type AND k.identity_key = ia.identity_key WHERE ia.workspace_id = ?1 AND ia.valid_from_generation <= ?2 AND (ia.valid_to_generation IS NULL OR ia.valid_to_generation > ?2) GROUP BY ia.identity_type, ia.identity_key), previous AS (SELECT ia.identity_type, ia.identity_key, ia.record_id FROM identity_assignments ia JOIN previous_generation p ON p.identity_type = ia.identity_type AND p.identity_key = ia.identity_key AND p.valid_from_generation = ia.valid_from_generation WHERE ia.workspace_id = ?1) INSERT INTO identity_assignments (identity_assignment_id, workspace_id, identity_type, identity_id, assignment_kind, identity_key, identity_key_digest, record_id, previous_record_id, owner_artifact_id, owner_artifact_version_id, valid_from_generation, valid_to_generation) SELECT 'sha256:' || lower(hex(o.identity_assignment_id)), ?1, o.identity_type, o.identity_type || ':' || lower(hex(o.identity_id)), CASE WHEN previous.record_id IS NULL THEN 'created' ELSE 'continued' END, o.identity_key, 'sha256:' || lower(hex(o.identity_key_digest)), 'record:' || lower(hex(o.publication_record_id)), previous.record_id, NULL, NULL, ?2, NULL FROM urdira_core_owner_rows o LEFT JOIN previous ON previous.identity_type = o.identity_type AND previous.identity_key = o.identity_key WHERE o.lane = 'records' AND o.identity_assignment_id IS NOT NULL ON CONFLICT DO NOTHING"
        } else {
            // A cold workspace has no predecessor assignments. Avoid the
            // windowed previous-row scan and sort; every accepted identity is
            // necessarily a newly created assignment. Replay/incremental
            // generations retain the conflict-safe branch above.
            "INSERT INTO identity_assignments (identity_assignment_id, workspace_id, identity_type, identity_id, assignment_kind, identity_key, identity_key_digest, record_id, previous_record_id, owner_artifact_id, owner_artifact_version_id, valid_from_generation, valid_to_generation) SELECT 'sha256:' || lower(hex(o.identity_assignment_id)), ?1, o.identity_type, o.identity_type || ':' || lower(hex(o.identity_id)), 'created', o.identity_key, 'sha256:' || lower(hex(o.identity_key_digest)), 'record:' || lower(hex(o.publication_record_id)), NULL, NULL, NULL, ?2, NULL FROM urdira_core_owner_rows o WHERE o.lane = 'records' AND o.identity_assignment_id IS NOT NULL"
        };
        transaction
            .execute(
                direct_identity_sql,
                params![&request.workspace_id, generation],
            )
            .map_err(sql_error)?;
        debug_publish_phase(publish_started, "promo_identity_insert");
    } else {
        transaction
            .execute(identity_insert_sql, [&request.candidate_generation_id])
            .map_err(sql_error)?;
        debug_publish_phase(publish_started, "promo_identity_insert");
    }
    debug_publish_phase(publish_started, "record_and_identity_promotion");
    transaction.execute("UPDATE candidate_publication_projection_occurrences SET valid_from_generation = ?1 WHERE candidate_generation_id = ?2", params![generation, &request.candidate_generation_id]).map_err(sql_error)?;
    transaction.execute("UPDATE candidate_publication_projection_dependencies SET valid_from_generation = ?1 WHERE candidate_generation_id = ?2", params![generation, &request.candidate_generation_id]).map_err(sql_error)?;
    transaction.execute("UPDATE candidate_publication_projection_value_nodes SET valid_from_generation = ?1 WHERE candidate_generation_id = ?2", params![generation, &request.candidate_generation_id]).map_err(sql_error)?;
    transaction.execute("INSERT INTO projection_occurrences (projection_record_id, workspace_id, projection_kind, projection_key, owner_artifact_id, owner_artifact_version_id, source_artifact_version_ids, source_record_ids, source_projection_record_ids, generator, generator_version, generator_configuration_digest, valid_from_generation, valid_to_generation, content_digest) SELECT projection_record_id, workspace_id, projection_kind, projection_key, owner_artifact_id, owner_artifact_version_id, source_artifact_version_ids, source_record_ids, source_projection_record_ids, generator, generator_version, generator_configuration_digest, valid_from_generation, NULL, content_digest FROM candidate_publication_projection_occurrences WHERE candidate_generation_id = ?1 ON CONFLICT(workspace_id, projection_record_id, valid_from_generation) DO NOTHING", [&request.candidate_generation_id]).map_err(sql_error)?;
    transaction.execute("INSERT OR IGNORE INTO projection_occurrence_dependencies (workspace_id, projection_record_id, valid_from_generation, source_type, source_id) SELECT workspace_id, projection_record_id, valid_from_generation, source_type, source_id FROM candidate_publication_projection_dependencies WHERE candidate_generation_id = ?1", [&request.candidate_generation_id]).map_err(sql_error)?;
    // Ordered by the destination PK's varying suffix (record_id, value_path;
    // workspace_id/valid_from_generation are constant for this insert) so the
    // B-tree receives sequential keys instead of the TEMP relation's arrival
    // order. This mirrors the identity/facet promotion above and is safe here
    // because row order is not part of the v3 byte contract.
    transaction.execute("INSERT INTO projection_value_nodes (workspace_id, record_id, valid_from_generation, value_path, parent_path, sequence_ordinal, map_key, value_kind, text_value, integer_value, real_value, bool_value, bytes_value) SELECT workspace_id, record_id, valid_from_generation, value_path, parent_path, sequence_ordinal, map_key, value_kind, text_value, integer_value, real_value, bool_value, bytes_value FROM candidate_publication_projection_value_nodes WHERE candidate_generation_id = ?1 ORDER BY record_id, value_path ON CONFLICT(workspace_id, record_id, valid_from_generation, value_path) DO UPDATE SET parent_path = excluded.parent_path, sequence_ordinal = excluded.sequence_ordinal, map_key = excluded.map_key, value_kind = excluded.value_kind, text_value = excluded.text_value, integer_value = excluded.integer_value, real_value = excluded.real_value, bool_value = excluded.bool_value, bytes_value = excluded.bytes_value", [&request.candidate_generation_id]).map_err(sql_error)?;
    if let Some(closures) = publication
        .get("projection_closures")
        .and_then(Value::as_array)
    {
        for closure in closures {
            if let Some(id) = closure.get("projection_record_id").and_then(Value::as_str) {
                transaction.execute("UPDATE projection_occurrences SET valid_to_generation = ?1 WHERE workspace_id = ?2 AND projection_record_id = ?3 AND valid_to_generation IS NULL", params![generation, &request.workspace_id, id]).map_err(sql_error)?;
            }
        }
    }

    // A cold workspace has no durable dependency rows either. Drop the
    // read-path secondary indexes before the bulk insert below for the same
    // reason as the record_occurrences/identity_assignments indexes above:
    // none of them back this INSERT's own conflict resolution (only the
    // dependency_entry_id primary key does, and that autoindex cannot be
    // dropped), and none are consulted again before this transaction
    // commits. artifact_dependencies_digest_scan_idx is deliberately kept:
    // the projection_set_digest phase later in this same transaction scans
    // artifact_dependencies through exactly that index shape, and dropping
    // it here would just move the cost instead of removing it.
    let dependencies_exist: bool = transaction
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM artifact_dependencies WHERE workspace_id = ?1 LIMIT 1)",
            [&request.workspace_id],
            |row| row.get(0),
        )
        .map_err(sql_error)?;
    if cold_direct && !dependencies_exist {
        transaction
            .execute_batch(
                "DROP INDEX IF EXISTS artifact_dependencies_reverse_idx; DROP INDEX IF EXISTS artifact_dependencies_direct_idx;",
            )
            .map_err(sql_error)?;
    }
    // Promote the generic dependency lane directly from the indexing-core
    // TEMP relation. Rust no longer copies every canonical row through the
    // legacy candidate_staged_* tables; those tables belong to the retired
    // TypeScript writer. Record ids and owner bindings are already sealed in
    // the same Rust-owned relation used for publication. Ordered by the
    // destination PK's varying suffix (dependency_entry_id) so the primary
    // key autoindex receives sequential keys instead of the TEMP relation's
    // arrival order; unlike the record_occurrences insert above this row
    // carries no wide body payload, so the sort is cheap relative to the
    // B-tree locality it buys (measured on a synthetic 3.2M-row/no-blob
    // insert: ~20% faster ordered than unordered under the workspace's
    // 1 GiB cache_size).
    transaction
        .execute(
            "INSERT INTO artifact_dependencies (dependency_entry_id, workspace_id, record_id, owner_artifact_id, owner_artifact_version_id, dependency_artifact_id, dependency_artifact_version_id, dependency_role, producer_id, producer_version, valid_from_generation, valid_to_generation, content_digest) SELECT dependencies.dependency_id, ?1, COALESCE('record:' || lower(hex(records.publication_record_id)), dependencies.proposal_key), dependencies.owner_artifact_id, dependencies.owner_artifact_version_id, dependencies.dependency_artifact_id, dependencies.dependency_artifact_version_id, dependencies.dependency_role, ?2, ?3, ?4, NULL, dependencies.dependency_content_digest FROM urdira_core_owner_rows AS dependencies LEFT JOIN urdira_core_owner_rows AS records ON records.owner_artifact_id = dependencies.owner_artifact_id AND records.owner_artifact_version_id = dependencies.owner_artifact_version_id AND records.observation_lane = dependencies.observation_lane AND records.sequence = dependencies.sequence AND records.lane = 'records' AND records.proposal_key = dependencies.proposal_key WHERE dependencies.lane = 'dependencies' ORDER BY dependencies.dependency_id ON CONFLICT(workspace_id, dependency_entry_id, valid_from_generation) DO UPDATE SET content_digest = excluded.content_digest WHERE artifact_dependencies.workspace_id = excluded.workspace_id AND artifact_dependencies.record_id = excluded.record_id AND artifact_dependencies.owner_artifact_id = excluded.owner_artifact_id AND artifact_dependencies.owner_artifact_version_id = excluded.owner_artifact_version_id AND artifact_dependencies.dependency_artifact_id = excluded.dependency_artifact_id AND artifact_dependencies.dependency_artifact_version_id = excluded.dependency_artifact_version_id AND artifact_dependencies.dependency_role = excluded.dependency_role AND artifact_dependencies.producer_id = excluded.producer_id AND artifact_dependencies.producer_version = excluded.producer_version AND artifact_dependencies.valid_to_generation IS excluded.valid_to_generation",
            params![
                &request.workspace_id,
                &request.engine.engine_id,
                &request.engine.engine_version,
                generation,
            ],
        )
        .map_err(sql_error)?;
    debug_publish_phase(publish_started, "dependency_promotion");

    // The digest scan immediately below reads every visible record in
    // record_id order (record_occurrences_digest_order_idx exists precisely
    // for that read; see packages/storage/sql/workspace-v3.sql). It was
    // dropped above alongside the other cold-direct promotion accelerators,
    // so without recreating it here the scan falls back to the record_id
    // primary-key autoindex plus a per-row table lookup for record_digest --
    // measured at +27s on the n8n corpus
    // (docs/evidence/2026-09-01-f1-resultado.md). EXPLAIN QUERY PLAN
    // confirms this index, not record_occurrences_workspace_owner_version_idx
    // (which only serves the incremental owner-history join/anti-join and is
    // unused by a cold-direct publication), turns both the COUNT and the
    // ordered SELECT below into index-only scans. Recreate it inline, inside
    // this same transaction, before the scan runs -- it therefore has its own
    // `COLD_DIRECT_DIGEST_ORDER_ACCEL_INDEX` constant rather than sharing the
    // `COLD_DIRECT_A1_ACCEL_INDEXES`/`COLD_DIRECT_NET_ACCEL_INDEXES` lists
    // built later in this same transaction.
    if cold_direct {
        let digest_index_started = Instant::now();
        transaction
            .execute(COLD_DIRECT_DIGEST_ORDER_ACCEL_INDEX.1, [])
            .map_err(sql_error)?;
        if std::env::var_os("URDIRA_DEBUG_TIMING").is_some() {
            eprintln!(
                "[urdira-indexing-worker] publish digest_order_index_rebuild_ms={}",
                digest_index_started.elapsed().as_millis()
            );
        }
    }

    let canonical_record_set_digest =
        canonical_visible_record_set_digest(transaction, &request.workspace_id, generation)?;
    debug_publish_phase(publish_started, "visible_record_digest");

    let materialization_fields = materialization.as_object().cloned().unwrap_or_default();
    let source_descriptor = materialization_fields
        .get("source_transition_template_set")
        .and_then(Value::as_str)
        .unwrap_or("{\"change_set_kind\":\"core:artifact_change_set\",\"entry_schema_version\":\"1\",\"comparator_id\":\"core:lexicographic_uri\",\"comparator_version\":\"1\",\"entry_count\":0,\"content_digest\":\"sha256:0000000000000000000000000000000000000000000000000000000000000000\"}");
    let closure_count: i64 = transaction.query_row("SELECT COUNT(*) FROM candidate_publication_record_closures WHERE candidate_generation_id = ?1", [&request.candidate_generation_id], |row| row.get(0)).map_err(sql_error)?;
    let closure_descriptor = materialization_fields
        .get("record_closure_template_set")
        .and_then(Value::as_str)
        .and_then(|text| serde_json::from_str::<Value>(text).ok())
        .unwrap_or_else(|| {
            serde_json::from_str(&descriptor(
                "core:record_closure_set",
                closure_count,
                &record_sequence_digest,
            ))
            .expect("descriptor JSON")
        });
    let record_open_descriptor = materialization_fields
        .get("record_open_template_set")
        .and_then(Value::as_str)
        .and_then(|text| serde_json::from_str::<Value>(text).ok())
        .unwrap_or_else(|| {
            serde_json::from_str(&descriptor(
                "core:record_open_set",
                record_count,
                &record_sequence_digest,
            ))
            .expect("descriptor JSON")
        });
    let identity_descriptor = materialization_fields
        .get("identity_assignment_template_set")
        .and_then(Value::as_str)
        .and_then(|text| serde_json::from_str::<Value>(text).ok())
        .unwrap_or_else(|| {
            serde_json::from_str(&descriptor(
                "core:identity_assignment_set",
                identity_count,
                &identity_sequence_digest,
            ))
            .expect("descriptor JSON")
        });
    let projection_descriptor = materialization_fields
        .get("projection_open_template_sets")
        .and_then(Value::as_array)
        .map(|entries| {
            let mut all = entries.clone();
            if let Some(closures) = materialization_fields.get("projection_closure_template_sets").and_then(Value::as_array) { all.extend(closures.iter().cloned()); }
            serde_json::json!({"change_set_kind":"core:projection_change_set","entry_schema_version":"1","comparator_id":"core:lexicographic_uri","comparator_version":"1","entry_count":all.len(),"content_digest":canonical_array_digest(&all)})
        })
        .unwrap_or_else(|| serde_json::from_str(&descriptor("core:projection_change_set", 0, "sha256:0000000000000000000000000000000000000000000000000000000000000000")).expect("descriptor JSON"));
    let manifest_fields = serde_json::json!({
        "artifact_change_set": change_set_descriptor(source_descriptor, "core:artifact_change_set"),
        "record_open_set": change_set_descriptor_value(record_open_descriptor, "core:record_open_set"),
        "record_closure_set": change_set_descriptor_value(closure_descriptor, "core:record_closure_set"),
        "identity_assignment_set": change_set_descriptor_value(identity_descriptor, "core:identity_assignment_set"),
        "projection_change_sets": projection_descriptor,
    });
    let publication_kind =
        value_string(publication, "publication_kind").unwrap_or_else(|_| "activation".into());
    let base_snapshot_id = publication
        .get("frozen_base")
        .and_then(|v| value_optional_string(v, "snapshot_id"));
    let manifest_digest = json_digest(
        &serde_json::json!({"generation_manifest_id":manifest_id,"workspace_id":request.workspace_id,"candidate_generation_id":request.candidate_generation_id,"generation":generation,"snapshot_id":snapshot_id,"base_snapshot_id":base_snapshot_id,"registry_snapshot_id":request.registry_snapshot_id,"publication_kind":publication_kind,"published_at":published_at,"artifact_change_set":manifest_fields["artifact_change_set"],"record_open_set":manifest_fields["record_open_set"],"record_closure_set":manifest_fields["record_closure_set"],"identity_assignment_set":manifest_fields["identity_assignment_set"],"projection_change_sets":manifest_fields["projection_change_sets"]}),
    );
    transaction.execute("INSERT INTO generation_manifests (generation_manifest_id, workspace_id, candidate_generation_id, generation, snapshot_id, base_snapshot_id, registry_snapshot_id, publication_kind, published_at, artifact_change_set, record_open_set, record_closure_set, identity_assignment_set, projection_change_sets, manifest_digest) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15) ON CONFLICT DO NOTHING", params![&manifest_id,&request.workspace_id,&request.candidate_generation_id,generation,&snapshot_id,base_snapshot_id,&request.registry_snapshot_id,publication_kind,&published_at,manifest_fields["artifact_change_set"].to_string(),manifest_fields["record_open_set"].to_string(),manifest_fields["record_closure_set"].to_string(),manifest_fields["identity_assignment_set"].to_string(),manifest_fields["projection_change_sets"].to_string(),manifest_digest]).map_err(sql_error)?;
    let watermark_values = serde_json::to_string(
        materialization_fields
            .get("source_observation_watermarks")
            .unwrap_or(&Value::Array(Vec::new())),
    )
    .unwrap_or_else(|_| "[]".into());
    let batch_values = serde_json::to_string(
        candidate
            .get("source_observation_batch_ids")
            .unwrap_or(&Value::Array(Vec::new())),
    )
    .unwrap_or_else(|_| "[]".into());
    let watermarks_text = format!(
        "{{\"watermarks\":{watermark_values},\"source_observation_batch_ids\":{batch_values}}}"
    );
    let projection_set_digests =
        projection_set_entries(transaction, &request.workspace_id, generation)?;
    debug_publish_phase(publish_started, "projection_set_digest");
    let projection_set_digests_text = ordered_projection_set_json(&projection_set_digests);
    let mut capability_entries = materialization_fields
        .get("capability_state_entries")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    capability_entries.sort_by(|left, right| {
        let mut left_bytes = Vec::new();
        let mut right_bytes = Vec::new();
        uce(left, &mut left_bytes);
        uce(right, &mut right_bytes);
        left_bytes.cmp(&right_bytes)
    });
    let capability_state_digest = canonical_array_digest(&capability_entries);
    let mut snapshot_object = serde_json::Map::from_iter([
        ("snapshot_id".into(), Value::String(snapshot_id.clone())),
        (
            "workspace_id".into(),
            Value::String(request.workspace_id.clone()),
        ),
        ("generation".into(), Value::Number(generation.into())),
        (
            "generation_manifest_id".into(),
            Value::String(manifest_id.clone()),
        ),
        (
            "registry_snapshot_id".into(),
            Value::String(request.registry_snapshot_id.clone()),
        ),
        (
            "resolution_lock_id".into(),
            Value::String(request.resolution_lock_id.clone()),
        ),
        (
            "configuration_revision_id".into(),
            Value::String(request.configuration_revision_id.clone()),
        ),
        (
            "source_state_digest".into(),
            Value::String(request.source_state_digest.clone()),
        ),
        (
            "source_observation_watermarks".into(),
            Value::String(watermarks_text.clone()),
        ),
        (
            "canonical_record_set_digest".into(),
            Value::String(canonical_record_set_digest.clone()),
        ),
        (
            "projection_set_digests".into(),
            Value::String(projection_set_digests_text.clone()),
        ),
        (
            "capability_state_digest".into(),
            Value::String(capability_state_digest.clone()),
        ),
        ("published_at".into(), Value::String(published_at.clone())),
    ]);
    if let Some(parent) = base_snapshot_id.clone() {
        snapshot_object.insert("parent_snapshot_id".into(), Value::String(parent));
    }
    if let Some(source) = publication
        .get("source_snapshot_id")
        .and_then(Value::as_str)
    {
        snapshot_object.insert(
            "source_snapshot_id".into(),
            Value::String(source.to_owned()),
        );
        snapshot_object.insert("snapshot_contract_version".into(), Value::Number(2.into()));
    }
    if let Some(stage) = publication
        .get("publication_stage_id")
        .and_then(Value::as_str)
    {
        snapshot_object.insert(
            "publication_stage_id".into(),
            Value::String(stage.to_owned()),
        );
        if let Some(value) = publication
            .get("publication_stage_ordinal")
            .and_then(Value::as_i64)
        {
            snapshot_object.insert(
                "publication_stage_ordinal".into(),
                Value::Number(value.into()),
            );
        }
        if let Some(value) = publication
            .get("publication_stage_count")
            .and_then(Value::as_i64)
        {
            snapshot_object.insert(
                "publication_stage_count".into(),
                Value::Number(value.into()),
            );
        }
    }
    let snapshot_payload = Value::Object(snapshot_object);
    let snapshot_digest = digest_envelope(
        "core:snapshot",
        "core:snapshot_digest",
        "core:SnapshotDigestPayload",
        &snapshot_payload,
    );
    transaction.execute("INSERT INTO snapshots (snapshot_id, workspace_id, generation, parent_snapshot_id, generation_manifest_id, registry_snapshot_id, resolution_lock_id, configuration_revision_id, source_state_digest, source_snapshot_id, snapshot_contract_version, publication_stage_id, publication_stage_ordinal, publication_stage_count, source_observation_watermarks, canonical_record_set_digest, projection_set_digests, capability_state_digest, published_at, snapshot_digest) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20) ON CONFLICT DO NOTHING", params![&snapshot_id,&request.workspace_id,generation,base_snapshot_id,&manifest_id,&request.registry_snapshot_id,&request.resolution_lock_id,&request.configuration_revision_id,&request.source_state_digest,publication.get("source_snapshot_id").and_then(Value::as_str),publication.get("source_snapshot_id").map(|_| 2_i64),publication.get("publication_stage_id").and_then(Value::as_str),publication.get("publication_stage_ordinal").and_then(Value::as_i64),publication.get("publication_stage_count").and_then(Value::as_i64),watermarks_text,canonical_record_set_digest,projection_set_digests_text,capability_state_digest,&published_at,snapshot_digest]).map_err(sql_error)?;
    let materialization_object = materialization.as_object().cloned().unwrap_or_default();
    let materialization_id = materialization_object
        .get("candidate_materialization_id")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .unwrap_or_else(|| {
            format!(
                "materialization:{}",
                json_digest(&materialization).trim_start_matches("sha256:")
            )
        });
    let materialization_digest = materialization_object
        .get("materialization_digest")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .unwrap_or_else(|| json_digest(&materialization));
    transaction.execute("INSERT INTO candidate_materializations (candidate_materialization_id, workspace_id, candidate_generation_id, materialization_digest, sealed_at, materialization_contract_text) VALUES (?1, ?2, ?3, ?4, ?5, ?6) ON CONFLICT(candidate_materialization_id) DO NOTHING", params![&materialization_id, &request.workspace_id, &request.candidate_generation_id, &materialization_digest, &published_at, json_text(&materialization)]).map_err(sql_error)?;
    transaction.execute("UPDATE candidate_state SET state = 'published', candidate_materialization_id = ?1, candidate_digest = ?2, finished_at = ?3, published_snapshot_id = ?4, published_generation = ?5, generation_manifest_id = ?6 WHERE workspace_id = ?7 AND candidate_generation_id = ?8 AND state NOT IN ('published', 'stale', 'cleaned')", params![&materialization_id,&materialization_digest,&published_at,&snapshot_id,generation,&manifest_id,&request.workspace_id,&request.candidate_generation_id]).map_err(sql_error)?;
    transaction.execute("INSERT INTO candidate_publication_journal (candidate_generation_id, workspace_id, status, snapshot_id, generation_manifest_id, generation, published_at, publication_digest) VALUES (?1, ?2, 'published', ?3, ?4, ?5, ?6, ?7) ON CONFLICT DO NOTHING", params![&request.candidate_generation_id,&request.workspace_id,&snapshot_id,&manifest_id,generation,&published_at,json_digest(&serde_json::json!({"candidate":candidate,"frozen_base":publication.get("frozen_base")}))]).map_err(sql_error)?;
    // Keep the four indexes used by the very first incremental closure
    // (the edit that lands right after this cold commit) available at the
    // cold commit itself. Without record_occurrences_workspace_owner_idx in
    // particular, DIRECT_PUBLICATION_CLOSURES_SQL's identity_assignments/
    // record_occurrences join (see the `lib.rs` test
    // `direct_publication_closures_search_every_index_and_never_scan`, which
    // asserts this exact
    // `SEARCH r USING INDEX record_occurrences_workspace_owner_idx` plan)
    // has no choice but a full scan of every visible row -- measured
    // at +14s on a 3.19M-row corpus for a single-file edit
    // (docs/evidence/2026-09-01-f5-e3-cierre-tanda.md, A1).
    //
    // The remaining five accelerators (`COLD_DIRECT_NET_ACCEL_INDEXES`) used
    // to be left to a *detached* post-publication rebuild pass. That pass
    // raced every subsequent structural generation for the workspace writer
    // lease with a single-attempt `open` and ceded to scan-priority on every
    // retry, so on a busy corpus it could requeue indefinitely and never
    // complete -- "secondary indexes ready" would simply never print. None
    // of the five participate in the cold-direct INSERTs' own conflict
    // resolution (see the safety-invariant comment above the DROP INDEX
    // statements earlier in this function), so building them here, inline,
    // in the same transaction and measured under the same
    // `cold_index_rebuild_ms` total as the four above, is safe and removes
    // the starvation risk entirely.
    if cold_direct {
        let cold_index_rebuild_started = Instant::now();
        let debug_timing = std::env::var_os("URDIRA_DEBUG_TIMING").is_some();
        for (name, sql) in COLD_DIRECT_A1_ACCEL_INDEXES
            .iter()
            .chain(COLD_DIRECT_NET_ACCEL_INDEXES)
        {
            let per_index_started = Instant::now();
            transaction.execute(sql, []).map_err(sql_error)?;
            if debug_timing {
                eprintln!(
                    "[urdira-indexing-worker] publish cold_index_rebuild index={name} elapsed_ms={}",
                    per_index_started.elapsed().as_millis()
                );
            }
        }
        if debug_timing {
            eprintln!(
                "[urdira-indexing-worker] publish cold_index_rebuild_ms={}",
                cold_index_rebuild_started.elapsed().as_millis()
            );
        }
        debug_publish_phase(publish_started, "cold_index_rebuild");

        // Give the query planner real statistics for the two durable tables
        // `DIRECT_PUBLICATION_CLOSURES_SQL` reads, right alongside the
        // indexes just (re)created above -- see `COLD_DIRECT_ANALYZE_SQL`'s
        // doc comment (urdira-indexing-core) for the full measured
        // before/after and the two cheaper variants that were rejected.
        // Runs once, inline, in the cold-direct commit -- not on any edit's
        // critical path.
        let analyze_stats_started = Instant::now();
        transaction
            .execute_batch(COLD_DIRECT_ANALYZE_SQL)
            .map_err(sql_error)?;
        if std::env::var_os("URDIRA_DEBUG_TIMING").is_some() {
            eprintln!(
                "[urdira-indexing-worker] publish analyze_stats_ms={}",
                analyze_stats_started.elapsed().as_millis()
            );
        }
        debug_publish_phase(publish_started, "analyze_stats");
    }

    // A per-publish `PRAGMA optimize;` (to keep stats fresh as a workspace
    // grows) was tried and measured live on the n8n-corpus gate (2,000
    // owners, one single-file mutation): `optimize_stats_ms=802` against a
    // ~1,323ms total incremental `rust core publish ms` -- SQLite's "only
    // re-analyzes when it judges a table has changed enough" heuristic did
    // NOT fall through to a no-op on this small, ordinary edit the way the
    // cold-commit case did (`optimize_stats_ms=53`, immediately after the
    // explicit `ANALYZE` above). That is squarely on the edit critical path
    // and not despreciable, so it was dropped rather than shipped; only the
    // one-time, inline, cold-commit `ANALYZE` above (never on an edit's
    // critical path) is kept. See docs/evidence for the full before/after.

    let current = transaction.query_row("SELECT current_snapshot_id, current_generation, state_revision FROM workspace_current_state WHERE workspace_id = ?1", [&request.workspace_id], |row| Ok((row.get::<_,String>(0)?,row.get::<_,i64>(1)?,row.get::<_,i64>(2)?))).optional().map_err(sql_error)?;
    if let Some((old_snapshot, old_generation, revision)) = current {
        let changed = transaction.execute("UPDATE workspace_current_state SET current_snapshot_id = ?1, current_generation = ?2, current_registry_snapshot_id = ?3, current_resolution_lock_id = ?4, current_configuration_revision_id = ?5, current_freshness_checkpoint_id = ?6, state_revision = ?7, updated_at = ?8 WHERE workspace_id = ?9 AND current_snapshot_id = ?10 AND current_generation = ?11 AND state_revision = ?12", params![&snapshot_id,generation,&request.registry_snapshot_id,&request.resolution_lock_id,&request.configuration_revision_id,&freshness_id,revision+1,&published_at,&request.workspace_id,old_snapshot,old_generation,revision]).map_err(sql_error)?;
        if changed != 1 {
            return Err(CoreError(
                "workspace current tuple changed during Rust publication".into(),
            ));
        }
    } else {
        transaction.execute("INSERT INTO workspace_current_state (workspace_id, current_snapshot_id, current_generation, current_registry_snapshot_id, current_resolution_lock_id, current_configuration_revision_id, current_freshness_checkpoint_id, state_revision, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 1, ?8)", params![&request.workspace_id,&snapshot_id,generation,&request.registry_snapshot_id,&request.resolution_lock_id,&request.configuration_revision_id,&freshness_id,&published_at]).map_err(sql_error)?;
    }
    debug_publish_phase(publish_started, "snapshot_and_current_state");
    Ok(())
}

fn debug_publish_phase(started: Instant, phase: &str) {
    if std::env::var_os("URDIRA_DEBUG_TIMING").is_some() {
        eprintln!(
            "[urdira-indexing-worker] publication phase={} elapsed_ms={}",
            phase,
            started.elapsed().as_millis()
        );
    }
}

fn write_event<W: Write>(
    writer: &mut W,
    stream_id: u32,
    cancellation_id: &str,
    event: &IndexingEvent,
) -> Result<(), Box<dyn std::error::Error>> {
    let frames = encode_message(
        event,
        &FrameOptions {
            stream_id,
            cancellation_id,
            byte_budget: 16 * 1024 * 1024,
            in_flight_budget: 16 * 1024 * 1024,
        },
    )?;
    for frame in frames {
        writer.write_all(&frame)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use sha2::Digest;
    use std::path::PathBuf;
    use urdira_indexing_core::{
        EngineDescriptor, OwnerObservation, StructuralKernelRecord, artifact_dependency_digest,
    };
    use urdira_jsts_syntax_worker::{SemanticSite, SiteDisposition, SiteKind};
    use urdira_worker_protocol::AuthoritativeChangeSet;

    fn test_request() -> GenerationRequest {
        GenerationRequest {
            operation_id: "operation:worker-test".into(),
            workspace_id: "workspace:worker-test".into(),
            candidate_generation_id: "candidate:worker-test".into(),
            cancellation_path: None,
            direct_publication: false,
            source_snapshot_id: "snapshot:worker-test".into(),
            cas_root: "/tmp/urdira-cas".into(),
            source_state_digest: "sha256:source".into(),
            base_generation: 0,
            registry_snapshot_id: "registry:worker-test".into(),
            configuration_revision_id: "configuration:worker-test".into(),
            resolution_lock_id: "lock:worker-test".into(),
            workspace_schema_digest: None,
            change_set: AuthoritativeChangeSet::Full,
            candidate: None,
            frozen_base: None,
            work_manifest: None,
            engine: EngineDescriptor {
                engine_id: "urdira:jsts".into(),
                engine_version: "1".into(),
                implementation_digest: "sha256:engine".into(),
            },
            deadline_ms: None,
        }
    }

    /// T3 (docs/evidence/2026-09-02): a cold-direct publication used to
    /// leave five derived accelerator indexes to a *detached*
    /// post-publication rebuild pass that raced every subsequent structural
    /// generation for the workspace writer lease with a single-attempt
    /// `open`, ceding to scan-priority on every retry -- on a busy corpus it
    /// could requeue indefinitely and never complete, so those five indexes
    /// could stay missing forever. All ten derived accelerators
    /// (`COLD_DIRECT_DIGEST_ORDER_ACCEL_INDEX`, `COLD_DIRECT_A1_ACCEL_INDEXES`,
    /// `COLD_DIRECT_NET_ACCEL_INDEXES`) are now built inline, synchronously,
    /// by the cold-direct commit itself. This test exercises exactly the SQL
    /// those three module-scope lists carry -- the same source the real
    /// `cold_direct` block in `finalize_workspace_publication` reads from --
    /// against a minimal stand-in schema covering only the columns those
    /// indexes reference, then asserts every one of the ten index names
    /// exists in `sqlite_schema` afterward. It is the guard against a future
    /// change silently dropping one of the ten, or reintroducing a detached
    /// rebuild that can starve.
    #[test]
    fn cold_direct_commit_builds_every_accelerator_index() {
        let db_path = std::env::temp_dir().join(format!(
            "urdira-indexing-worker-cold-direct-accel-indexes-{}-{:?}.sqlite",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_file(&db_path);
        let connection = rusqlite::Connection::open(&db_path).expect("open connection");
        connection
            .execute_batch(
                "CREATE TABLE record_occurrences (record_id TEXT NOT NULL, workspace_id TEXT NOT NULL, owner_artifact_id TEXT NOT NULL, owner_artifact_version_id TEXT NOT NULL, valid_from_generation INTEGER NOT NULL, valid_to_generation INTEGER, record_digest TEXT); \
                 CREATE TABLE identity_assignments (record_id TEXT NOT NULL, workspace_id TEXT NOT NULL, identity_type TEXT NOT NULL, identity_id TEXT, identity_key TEXT, identity_key_digest TEXT, valid_from_generation INTEGER NOT NULL, valid_to_generation INTEGER); \
                 CREATE TABLE artifact_dependencies (record_id TEXT NOT NULL, workspace_id TEXT NOT NULL, dependency_artifact_id TEXT, dependency_artifact_version_id TEXT, dependency_entry_id TEXT, dependency_role TEXT, valid_from_generation INTEGER NOT NULL, valid_to_generation INTEGER);",
            )
            .expect("schema");
        // Mirror the two-phase order the real cold-direct commit uses: the
        // digest-order index is built first (it gates the visible_record_digest
        // scan), the other nine later.
        connection
            .execute(COLD_DIRECT_DIGEST_ORDER_ACCEL_INDEX.1, [])
            .expect("digest order index");
        for (_, sql) in COLD_DIRECT_A1_ACCEL_INDEXES
            .iter()
            .chain(COLD_DIRECT_NET_ACCEL_INDEXES)
        {
            connection.execute(sql, []).expect("accelerator index");
        }
        let expected_names: Vec<&str> = std::iter::once(&COLD_DIRECT_DIGEST_ORDER_ACCEL_INDEX)
            .chain(COLD_DIRECT_A1_ACCEL_INDEXES.iter())
            .chain(COLD_DIRECT_NET_ACCEL_INDEXES.iter())
            .map(|(name, _)| *name)
            .collect();
        assert_eq!(
            expected_names.len(),
            10,
            "the cold commit builds ten total derived accelerator indexes: one digest-order + four A1 + five net-new"
        );
        for name in &expected_names {
            let present: i64 = connection
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_schema WHERE type = 'index' AND name = ?1",
                    [name],
                    |row| row.get(0),
                )
                .expect("count index");
            assert_eq!(
                present, 1,
                "{name} must exist after the cold-direct commit builds every accelerator index inline"
            );
        }
        drop(connection);
        let _ = std::fs::remove_file(&db_path);
    }

    /// A synthetic multi-group corpus for the facts pipeline tests below.
    /// Group boundaries are irrelevant here -- `FactsGroupPipeline` assigns
    /// its own contiguous `group_sequence` on submit -- only the owner rows
    /// inside each group matter. `group_count` / `owners_per_group` are
    /// parameterized so a stress test can exceed the channel/in-flight
    /// backpressure window (`FACTS_GROUP_CHANNEL_CAPACITY`), not just
    /// exercise the trivial "everything fits in flight" case.
    fn synthetic_facts_groups(
        group_count: u32,
        owners_per_group: u32,
    ) -> Vec<Vec<OwnerObservation>> {
        (0..group_count)
            .map(|group_index| {
                (0..owners_per_group)
                    .map(|owner_index| {
                        let path = format!("group{group_index}/owner{owner_index}.ts");
                        OwnerObservation {
                            owner_artifact_id: format!("artifact:{path}"),
                            owner_artifact_version_id: format!("version:{path}"),
                            owner_path: path.clone(),
                            lane: "syntax".into(),
                            sequence: 0,
                            final_batch: true,
                            records: vec![StructuralKernelRecord {
                                proposal_record_key: format!("proposal:{path}"),
                                category: "entity".into(),
                                kind: "jsts:entity_variable".into(),
                                universal_kind: "core:variable".into(),
                                facets: "[]".into(),
                                schema_version: 1,
                                source_span: "{}".into(),
                                identity_key: format!("identity:{path}"),
                                body: json!({"name": path}),
                                evidence_references: "[]".into(),
                            }],
                            dependencies: vec![],
                            byte_length: 0,
                            owner_digest: String::new(),
                            fact_delta_id: Some(format!("jsts:delta:test:{path}:0")),
                            delta_digest: None,
                        }
                    })
                    .collect()
            })
            .collect()
    }

    /// A giant multi-page owner: `page_count` separate `OwnerObservation`s
    /// that all share the same `owner_path` (and artifact identity) but
    /// have strictly increasing `sequence`, mirroring how a single large
    /// file's fact pages are split across several physical groups by the
    /// producer's byte/row budget. Each is returned as its own one-owner
    /// group so every page becomes a distinct `group_sequence`.
    fn synthetic_giant_owner_pages(page_count: u32) -> Vec<Vec<OwnerObservation>> {
        let path = "giant.ts".to_string();
        (0..page_count)
            .map(|page_index| {
                vec![OwnerObservation {
                    owner_artifact_id: format!("artifact:{path}"),
                    owner_artifact_version_id: format!("version:{path}"),
                    owner_path: path.clone(),
                    lane: "syntax".into(),
                    sequence: u64::from(page_index),
                    final_batch: page_index + 1 == page_count,
                    records: vec![StructuralKernelRecord {
                        proposal_record_key: format!("proposal:{path}:{page_index}"),
                        category: "entity".into(),
                        kind: "jsts:entity_variable".into(),
                        universal_kind: "core:variable".into(),
                        facets: "[]".into(),
                        schema_version: 1,
                        source_span: "{}".into(),
                        identity_key: format!("identity:{path}:{page_index}"),
                        body: json!({"name": path, "page": page_index}),
                        evidence_references: "[]".into(),
                    }],
                    dependencies: vec![],
                    byte_length: 0,
                    owner_digest: String::new(),
                    fact_delta_id: Some(format!("jsts:delta:test:{path}:{page_index}")),
                    delta_digest: None,
                }]
            })
            .collect()
    }

    /// Runs the given corpus through a fresh `FactsGroupPipeline` with the
    /// given worker count and returns the resulting core plus the receipt
    /// totals `run_jsts_generation` folds into its summary.
    fn run_facts_pipeline(
        parallelism: usize,
        groups: Vec<Vec<OwnerObservation>>,
    ) -> (IndexingCore, u64, u64, u64) {
        let request = test_request();
        let mut core = IndexingCore::open(":memory:", &request).expect("core");
        let mut engine = JavascriptTypescriptEngine::new(
            request.engine.engine_version.clone(),
            request.engine.implementation_digest.clone(),
        );
        let mut pipeline = FactsGroupPipeline::new(
            parallelism,
            &request.engine.engine_version,
            &request.engine.implementation_digest,
            core.cancellation(),
        );
        let mut group_count = 0_u64;
        let mut owner_count = 0_u64;
        let mut row_count = 0_u64;
        for mut owners in groups {
            let receipts = pipeline
                .submit(&mut engine, &mut core, &mut owners)
                .expect("submit synthetic group");
            fold_group_receipts(receipts, &mut group_count, &mut owner_count, &mut row_count);
        }
        let receipts = pipeline.finish(&mut core).expect("finish facts pipeline");
        fold_group_receipts(receipts, &mut group_count, &mut owner_count, &mut row_count);
        (core, group_count, owner_count, row_count)
    }

    #[test]
    fn facts_pipeline_parallel_matches_serial_across_group_sequence() {
        let (serial_core, serial_groups, serial_owners, serial_rows) =
            run_facts_pipeline(1, synthetic_facts_groups(6, 3));
        let (parallel_core, parallel_groups, parallel_owners, parallel_rows) =
            run_facts_pipeline(FACTS_GROUP_WORKER_CAP, synthetic_facts_groups(6, 3));

        // Same totals regardless of how many worker threads analyzed the
        // groups: the worker pool must never drop, duplicate, or reorder a
        // group relative to the fully serial path.
        assert_eq!(serial_groups, parallel_groups);
        assert_eq!(serial_owners, parallel_owners);
        assert_eq!(serial_rows, parallel_rows);
        assert_eq!(serial_groups, 6);
        assert_eq!(serial_owners, 18);

        // `seal` recomputes an order-dependent digest over every staged
        // group and owner sequence; a bit-identical match here is the
        // strongest available evidence that the parallel pipeline accepted
        // groups in exactly the same order, with exactly the same rows, as
        // the serial path.
        let request = test_request();
        let serial_descriptor = serial_core.seal(&request).expect("serial seal");
        let parallel_descriptor = parallel_core.seal(&request).expect("parallel seal");
        assert_eq!(
            serial_descriptor.ordered_digest,
            parallel_descriptor.ordered_digest
        );
        assert_eq!(
            serial_descriptor.group_count,
            parallel_descriptor.group_count
        );
        assert_eq!(
            serial_descriptor.owner_count,
            parallel_descriptor.owner_count
        );
        assert_eq!(serial_descriptor.row_count, parallel_descriptor.row_count);
    }

    #[test]
    fn facts_pipeline_survives_many_groups_past_the_backpressure_window() {
        // 80 groups x 4 owners = 320 owners and, critically, far more than
        // `FACTS_GROUP_CHANNEL_CAPACITY` (6) groups in total, so the
        // in-flight backpressure wait inside `FactsGroupWorkerPool::dispatch`
        // triggers repeatedly instead of never firing (the 6-group test
        // above never fills the window even once).
        let groups = synthetic_facts_groups(80, 4);
        let (serial_core, serial_groups, serial_owners, serial_rows) =
            run_facts_pipeline(1, groups.clone());
        let (parallel_core, parallel_groups, parallel_owners, parallel_rows) =
            run_facts_pipeline(FACTS_GROUP_WORKER_CAP, groups);

        assert_eq!(serial_groups, 80, "serial path must see every group");
        assert_eq!(
            parallel_groups, 80,
            "parallel path must report every physical group, not just a handful \
             (a regression here previously collapsed the reported count and \
             desynchronized the semantic lane's continuation sequence)"
        );
        assert_eq!(serial_owners, parallel_owners);
        assert_eq!(serial_rows, parallel_rows);

        let request = test_request();
        let serial_descriptor = serial_core.seal(&request).expect("serial seal");
        let parallel_descriptor = parallel_core.seal(&request).expect("parallel seal");
        assert_eq!(serial_descriptor.group_count, 80);
        assert_eq!(parallel_descriptor.group_count, 80);
        assert_eq!(
            serial_descriptor.ordered_digest,
            parallel_descriptor.ordered_digest
        );
    }

    #[test]
    fn facts_pipeline_handles_giant_multipage_owner_under_parallelism() {
        // A single owner whose fact pages are split across many physical
        // groups (each page is its own group, as the producer does when one
        // page alone saturates the row/byte budget). Every page shares the
        // same owner_path, which is exactly the shape that could race a
        // per-worker `JavascriptTypescriptEngine`'s enqueue/pop key if pages
        // of the same owner ever landed on the same thread concurrently.
        let pages = synthetic_giant_owner_pages(40);
        let (serial_core, serial_groups, serial_owners, serial_rows) =
            run_facts_pipeline(1, pages.clone());
        let (parallel_core, parallel_groups, parallel_owners, parallel_rows) =
            run_facts_pipeline(FACTS_GROUP_WORKER_CAP, pages);

        assert_eq!(serial_groups, 40);
        assert_eq!(parallel_groups, 40);
        assert_eq!(serial_owners, parallel_owners);
        assert_eq!(serial_rows, parallel_rows);

        let request = test_request();
        let serial_descriptor = serial_core.seal(&request).expect("serial seal");
        let parallel_descriptor = parallel_core.seal(&request).expect("parallel seal");
        assert_eq!(
            serial_descriptor.ordered_digest,
            parallel_descriptor.ordered_digest
        );
    }

    #[test]
    fn arc_request_slice_preserves_wire_json_without_deep_clones() {
        let values = vec![
            Arc::new(json!({"request_id":"one","payload":{"owner_path":"a.ts"}})),
            Arc::new(json!({"request_id":"two","payload":{"owner_path":"b.ts"}})),
        ];
        let borrowed = serde_json::to_vec(&ArcValueSlice(&values)).expect("borrowed request JSON");
        let owned = serde_json::to_vec(&values.iter().map(Arc::as_ref).collect::<Vec<_>>())
            .expect("owned request JSON");
        assert_eq!(borrowed, owned);
    }

    #[test]
    fn rust_resolves_jsts_sources_from_the_current_core_frontier() {
        let request = test_request();
        let mut core = IndexingCore::open(":memory:", &request).expect("core");
        core.with_transaction(|transaction| {
            transaction
                .execute_batch(
                    "CREATE TABLE source_artifacts (artifact_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, normalized_uri TEXT NOT NULL, normalized_path TEXT, display_path TEXT, artifact_kind TEXT NOT NULL); CREATE TABLE artifact_versions (artifact_version_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, artifact_id TEXT NOT NULL, content_hash TEXT NOT NULL, byte_length INTEGER NOT NULL, valid_to_generation INTEGER); INSERT INTO source_artifacts VALUES ('artifact:a','workspace:worker-test','a.ts','a.ts','a.ts','physical_file'), ('artifact:readme','workspace:worker-test','README.md','README.md','README.md','physical_file'); INSERT INTO artifact_versions VALUES ('version:a','workspace:worker-test','artifact:a','sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',12,NULL), ('version:readme','workspace:worker-test','artifact:readme','sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',8,NULL);",
                )
                .map_err(sql_error)
        })
        .expect("source frontier");
        let envelope: JstsGenerationInputEnvelope = serde_json::from_value(json!({
            "project_key": "project:worker-test",
            "configuration_digest": "sha256:configuration",
            "budgets": { "max_output_bytes": 1024, "max_files": 16, "max_source_bytes": 1024 }
        }))
        .expect("envelope");
        let resolved =
            resolve_jsts_generation_input(&mut core, &request, envelope).expect("resolve");
        assert_eq!(resolved.root_names, vec!["a.ts"]);
        assert_eq!(resolved.files.len(), 1);
        assert!(resolved.files[0].source_blob_path.contains("/sha256/aa/"));
        assert!(
            resolved.files[0]
                .source_blob_path
                .ends_with(&"a".repeat(62))
        );
    }

    #[test]
    fn rust_resolves_config_assets_from_the_current_core_frontier_alongside_jsts_sources() {
        // E2 (F5 hybrid design): the production route derives BOTH the
        // JS/TS source manifest and the resolution assets from the same
        // unfiltered frontier read -- `package.json`/`tsconfig.json`/
        // `pnpm-workspace.yaml` must land in `config_assets`, never in
        // `files` (they are not JS/TS sources), and an unrelated file
        // (`README.md`) must land in neither.
        let request = test_request();
        let mut core = IndexingCore::open(":memory:", &request).expect("core");
        core.with_transaction(|transaction| {
            transaction
                .execute_batch(
                    "CREATE TABLE source_artifacts (artifact_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, normalized_uri TEXT NOT NULL, normalized_path TEXT, display_path TEXT, artifact_kind TEXT NOT NULL); \
                     CREATE TABLE artifact_versions (artifact_version_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, artifact_id TEXT NOT NULL, content_hash TEXT NOT NULL, byte_length INTEGER NOT NULL, valid_to_generation INTEGER); \
                     INSERT INTO source_artifacts VALUES \
                        ('artifact:a','workspace:worker-test','a.ts','a.ts','a.ts','physical_file'), \
                        ('artifact:pkg','workspace:worker-test','package.json','package.json','package.json','physical_file'), \
                        ('artifact:nested-pkg','workspace:worker-test','packages/app/package.json','packages/app/package.json','packages/app/package.json','physical_file'), \
                        ('artifact:tsconfig','workspace:worker-test','tsconfig.json','tsconfig.json','tsconfig.json','physical_file'), \
                        ('artifact:pnpm','workspace:worker-test','pnpm-workspace.yaml','pnpm-workspace.yaml','pnpm-workspace.yaml','physical_file'), \
                        ('artifact:readme','workspace:worker-test','README.md','README.md','README.md','physical_file'); \
                     INSERT INTO artifact_versions VALUES \
                        ('version:a','workspace:worker-test','artifact:a','sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',12,NULL), \
                        ('version:pkg','workspace:worker-test','artifact:pkg','sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',8,NULL), \
                        ('version:nested-pkg','workspace:worker-test','artifact:nested-pkg','sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',8,NULL), \
                        ('version:tsconfig','workspace:worker-test','artifact:tsconfig','sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',8,NULL), \
                        ('version:pnpm','workspace:worker-test','artifact:pnpm','sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',8,NULL), \
                        ('version:readme','workspace:worker-test','artifact:readme','sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',8,NULL);",
                )
                .map_err(sql_error)
        })
        .expect("source frontier");
        let envelope: JstsGenerationInputEnvelope = serde_json::from_value(json!({
            "project_key": "project:worker-test",
            "configuration_digest": "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccconfiguration",
            "budgets": { "max_output_bytes": 1024, "max_files": 16, "max_source_bytes": 1024 }
        }))
        .expect("envelope");
        let resolved =
            resolve_jsts_generation_input(&mut core, &request, envelope).expect("resolve");
        assert_eq!(resolved.files.len(), 1);
        assert_eq!(resolved.files[0].path, "a.ts");
        let config_paths: std::collections::BTreeSet<&str> = resolved
            .config_assets
            .iter()
            .map(|asset| asset.path.as_str())
            .collect();
        assert_eq!(
            config_paths,
            [
                "package.json",
                "packages/app/package.json",
                "tsconfig.json",
                "pnpm-workspace.yaml",
            ]
            .into_iter()
            .collect()
        );
        assert!(!config_paths.contains("README.md"));
    }

    #[test]
    fn streamed_projection_digest_matches_canonical_value_digest() {
        let mut connection = rusqlite::Connection::open_in_memory().expect("connection");
        connection
            .execute_batch(
                "CREATE TABLE graph_edges (edge_id TEXT, workspace_id TEXT, valid_from_generation INTEGER, valid_to_generation INTEGER, content_digest TEXT); INSERT INTO graph_edges VALUES ('edge:b','workspace:test',1,NULL,'sha256:b'), ('edge:a','workspace:test',2,NULL,'sha256:a'), ('edge:closed','workspace:test',1,2,'sha256:closed');",
            )
            .expect("schema");
        let transaction = connection.transaction().expect("transaction");
        let configuration = logical_digest(
            &json!({
                "workspace_id": "workspace:test",
                "projection_kind": "graph",
                "generator": "urdira.storage.graph-adjacency",
                "generator_version": "1",
            }),
            "urdira:projection-generator:v2",
        );
        let actual = streamed_projection_set_digest(
            &transaction,
            "workspace:test",
            2,
            "graph",
            "urdira.storage.graph-adjacency",
            &configuration,
            "graph_edges",
            "edge_id",
        )
        .expect("streamed digest");
        let expected = logical_digest(
            &json!({
                "projection_kind": "graph",
                "generator": "urdira.storage.graph-adjacency",
                "generator_version": "1",
                "generator_configuration_digest": configuration,
                "entries": [
                    {"projection_record_id":"edge:a@2", "content_digest":"sha256:a"},
                    {"projection_record_id":"edge:b@1", "content_digest":"sha256:b"},
                ],
            }),
            "urdira:projection-set:v2",
        );
        assert_eq!(actual, expected);
        transaction.rollback().expect("rollback");
    }

    #[test]
    fn rust_derives_source_transition_metadata_from_capture_commits() {
        let mut connection = rusqlite::Connection::open_in_memory().expect("connection");
        connection
            .execute_batch(
                "CREATE TABLE artifact_versions (artifact_id TEXT, artifact_version_id TEXT, content_hash TEXT, analysis_metadata_digest TEXT, workspace_id TEXT, valid_to_generation INTEGER); CREATE TABLE artifact_tombstones (artifact_id TEXT, artifact_tombstone_id TEXT, absence_kind TEXT, workspace_id TEXT, valid_to_generation INTEGER); INSERT INTO artifact_versions VALUES ('artifact:a','version:old','sha256:old','sha256:meta','workspace:test',NULL);",
            )
            .expect("schema");
        let transaction = connection.transaction().expect("transaction");
        let commits = json!([{
            "batch": {"observation_batch_id": "batch:new"},
            "versions": [{
                "workspace_id": "workspace:test", "artifact_id": "artifact:a",
                "artifact_version_id": "version:new", "content_hash": "sha256:new",
                "analysis_metadata_digest": "sha256:meta", "created_from_observation_id": "observation:new",
                "valid_from_generation": 2, "valid_to_generation": null
            }],
            "tombstones": []
        }]);
        let transitions = derive_source_transitions(&transaction, "workspace:test", Some(&commits))
            .expect("derive")
            .expect("transitions")
            .as_array()
            .cloned()
            .expect("array");
        assert_eq!(transitions.len(), 1);
        assert_eq!(transitions[0]["artifact_change"]["change_kind"], "updated");
        assert_eq!(
            transitions[0]["artifact_change"]["previous_artifact_version_id"],
            "version:old"
        );
        assert!(
            transitions[0]["target_artifact_version_without_generation"]
                .get("valid_from_generation")
                .is_none()
        );
        transaction.rollback().expect("rollback");
    }

    #[test]
    fn rust_semantic_digest_matches_fact_delta_v2_commitment() {
        let payload = json!({
            "analysis_digest": "sha256:analysis",
            "analysis_configuration_digest": "sha256:config",
            "analysis_input_digest": "sha256:input",
            "created_at": "2030-01-01T00:00:00.000Z",
            "work_item": {
                "candidate_generation_id": "candidate:x",
                "workspace_id": "workspace:x",
                "artifact_id": "artifact:a",
                "target_artifact_version_id": "version:a",
                "work_item_id": "work:artifact:a",
                "plugin_id": "urdira:javascript_typescript",
                "plugin_version": "0.4.0",
                "expected_replacement_scopes": [{
                    "replacement_scope_id": "scope:a",
                    "owner_artifact_id": "artifact:a",
                    "owner_artifact_version_id": "version:a",
                    "capability": "core:call_relationships",
                    "record_categories": ["entity", "relation", "diagnostic"],
                    "record_kinds": ["jsts:relation_call"],
                    "base_record_set_digest": "sha256:empty",
                    "output_completeness": "accept_reported"
                }]
            },
            "accepted_manifest": {
                "plugin_input_access_manifest_id": "manifest:x",
                "manifest_digest": "sha256:manifest",
                "artifact_version_entries": [],
                "record_entries": []
            }
        });
        assert_eq!(
            rust_semantic_delta_digest(&payload, &[], &[]).expect("digest"),
            "sha256:7460b5d2978d1d61f67e425e99afd1975185a7cfaa8bb1a1dd8ff867e948a402"
        );
    }

    #[test]
    fn streaming_canonical_array_digest_matches_array_digest() {
        let values = vec![
            json!({"artifact_id": "artifact:a", "content_hash": "sha256:a"}),
            json!({"artifact_id": "artifact:b", "content_hash": "sha256:b"}),
        ];
        assert_eq!(
            canonical_sha256_array(&values),
            canonical_sha256(&Value::Array(values)),
        );
    }

    #[test]
    fn fixed_dependency_digest_matches_logical_object_digest() {
        let value = json!({
            "dependency_entry_id": "dependency:1",
            "workspace_id": "workspace:1",
            "record_id": "record:1",
            "owner_artifact_id": "artifact:1",
            "owner_artifact_version_id": "version:1",
            "dependency_artifact_id": "artifact:2",
            "dependency_artifact_version_id": "version:2",
            "dependency_role": "imports",
            "producer_id": "urdira:jsts",
            "producer_version": "1",
        });
        assert_eq!(
            artifact_dependency_digest(
                "dependency:1",
                "workspace:1",
                "record:1",
                "artifact:1",
                "version:1",
                "artifact:2",
                "version:2",
                "imports",
                "urdira:jsts",
                "1",
            ),
            logical_digest(&value, "urdira:artifact-dependency:v2")
        );
    }

    #[test]
    fn streamed_visible_record_digest_matches_canonical_array_digest() {
        let mut connection = rusqlite::Connection::open_in_memory().expect("connection");
        connection
            .execute_batch(
                "CREATE TABLE record_occurrences (record_id TEXT NOT NULL, record_digest TEXT NOT NULL, workspace_id TEXT NOT NULL, valid_from_generation INTEGER NOT NULL, valid_to_generation INTEGER); INSERT INTO record_occurrences VALUES ('record:b', 'sha256:b', 'workspace:test', 1, NULL), ('record:a', 'sha256:a', 'workspace:test', 1, NULL), ('record:closed', 'sha256:closed', 'workspace:test', 1, 2);",
            )
            .expect("schema");
        let transaction = connection.transaction().expect("transaction");
        let actual = canonical_visible_record_set_digest(&transaction, "workspace:test", 1)
            .expect("streamed digest");
        let expected = canonical_array_digest(&[
            json!({"record_id":"record:a","record_digest":"sha256:a"}),
            json!({"record_id":"record:b","record_digest":"sha256:b"}),
            json!({"record_id":"record:closed","record_digest":"sha256:closed"}),
        ]);
        assert_eq!(actual, expected);
        transaction.rollback().expect("rollback");
    }

    #[test]
    fn publication_sink_writes_set_based_metadata_columns() {
        let request = test_request();
        let path: PathBuf = std::env::temp_dir().join(format!(
            "urdira-indexing-worker-{}.sqlite",
            std::process::id()
        ));
        let setup = rusqlite::Connection::open(&path).expect("setup db");
        setup.execute_batch(
            "CREATE TABLE candidate_state (candidate_generation_id TEXT PRIMARY KEY); \
             CREATE TABLE candidate_fact_deltas (fact_delta_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, candidate_generation_id TEXT NOT NULL, delta_digest TEXT NOT NULL, accepted_at TEXT NOT NULL); \
             CREATE TABLE candidate_fact_delta_namespaces (fact_delta_key INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id TEXT NOT NULL, candidate_generation_id TEXT NOT NULL, fact_delta_id TEXT NOT NULL, producer_id TEXT, producer_version TEXT, owner_artifact_id TEXT, owner_artifact_version_id TEXT, analysis_digest TEXT, analysis_configuration_digest TEXT, UNIQUE(workspace_id, candidate_generation_id, fact_delta_id)); \
             CREATE TABLE candidate_fact_delta_batches (workspace_id TEXT NOT NULL, candidate_generation_id TEXT NOT NULL, fact_delta_id TEXT NOT NULL, sequence INTEGER NOT NULL, byte_length INTEGER NOT NULL, is_final INTEGER NOT NULL, accepted_at TEXT NOT NULL, PRIMARY KEY(workspace_id, candidate_generation_id, fact_delta_id, sequence)); \
             CREATE TABLE candidate_staged_records (fact_delta_key INTEGER NOT NULL, row_ordinal INTEGER NOT NULL, text_0 TEXT, text_1 TEXT, text_2 TEXT, text_3 TEXT, text_4 TEXT, text_5 TEXT, text_6 TEXT, text_7 TEXT, PRIMARY KEY(fact_delta_key, row_ordinal)); \
             CREATE TABLE candidate_staged_dependencies (fact_delta_key INTEGER NOT NULL, row_ordinal INTEGER NOT NULL, text_0 TEXT, text_1 TEXT, text_2 TEXT, text_3 TEXT, text_4 TEXT, text_5 TEXT, text_6 TEXT, text_7 TEXT, PRIMARY KEY(fact_delta_key, row_ordinal)); \
             CREATE TABLE candidate_publication_record_occurrences (candidate_generation_id TEXT NOT NULL, row_ordinal INTEGER NOT NULL, record_id TEXT NOT NULL, workspace_id TEXT NOT NULL, category TEXT NOT NULL, kind TEXT NOT NULL, universal_kind TEXT NOT NULL, schema_version INTEGER NOT NULL, producer_id TEXT NOT NULL, producer_version TEXT NOT NULL, owner_artifact_id TEXT NOT NULL, owner_artifact_version_id TEXT NOT NULL, primary_source_span_artifact_version_id TEXT, primary_source_span_start_byte TEXT, primary_source_span_end_byte TEXT, primary_source_span_start_line TEXT, primary_source_span_end_line TEXT, valid_from_generation INTEGER NOT NULL, record_digest TEXT NOT NULL, body_digest TEXT NOT NULL, body_byte_length INTEGER NOT NULL, body_payload BLOB, analysis_digest TEXT NOT NULL, analysis_configuration_digest TEXT NOT NULL, artifact_dependency_digest TEXT NOT NULL, PRIMARY KEY(candidate_generation_id, row_ordinal)); \
             CREATE TABLE candidate_publication_record_facets (candidate_generation_id TEXT NOT NULL, row_ordinal INTEGER NOT NULL, workspace_id TEXT NOT NULL, record_id TEXT NOT NULL, valid_from_generation INTEGER NOT NULL, facet_ordinal INTEGER NOT NULL, facet TEXT NOT NULL, PRIMARY KEY(candidate_generation_id, row_ordinal)); \
             CREATE TABLE candidate_publication_record_closures (candidate_generation_id TEXT NOT NULL, row_ordinal INTEGER NOT NULL, workspace_id TEXT NOT NULL, record_id TEXT NOT NULL, valid_to_generation INTEGER NOT NULL, PRIMARY KEY(candidate_generation_id, row_ordinal)); \
             CREATE TABLE candidate_publication_identity_assignments (candidate_generation_id TEXT NOT NULL, row_ordinal INTEGER NOT NULL, identity_assignment_id TEXT NOT NULL, workspace_id TEXT NOT NULL, identity_type TEXT NOT NULL, identity_id TEXT NOT NULL, assignment_kind TEXT NOT NULL, identity_key TEXT NOT NULL, identity_key_digest TEXT NOT NULL, record_id TEXT NOT NULL, previous_record_id TEXT, valid_from_generation INTEGER NOT NULL, PRIMARY KEY(candidate_generation_id, row_ordinal)); \
             CREATE TABLE identity_assignments (workspace_id TEXT NOT NULL, identity_type TEXT NOT NULL, identity_key TEXT NOT NULL, record_id TEXT NOT NULL, valid_from_generation INTEGER NOT NULL, valid_to_generation INTEGER); \
             CREATE TABLE record_occurrences (record_id TEXT NOT NULL, workspace_id TEXT NOT NULL, owner_artifact_id TEXT NOT NULL, valid_from_generation INTEGER NOT NULL, valid_to_generation INTEGER); \
             CREATE TABLE candidate_publication_projection_descriptors (candidate_generation_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, projection_count INTEGER NOT NULL, dependency_count INTEGER NOT NULL, value_node_count INTEGER NOT NULL, first_projection_record_id TEXT, last_projection_record_id TEXT, projection_sequence_digest TEXT NOT NULL, sealed_at TEXT NOT NULL); \
             CREATE TABLE candidate_publication_descriptors (candidate_generation_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, record_count INTEGER NOT NULL, facet_count INTEGER NOT NULL, identity_count INTEGER NOT NULL, canonical_byte_length INTEGER NOT NULL, first_record_id TEXT, last_record_id TEXT, record_sequence_digest TEXT NOT NULL, identity_sequence_digest TEXT NOT NULL, sealed_at TEXT NOT NULL);"
        ).expect("schema");
        setup
            .execute(
                "INSERT INTO candidate_state (candidate_generation_id) VALUES (?1)",
                [&request.candidate_generation_id],
            )
            .expect("candidate");
        drop(setup);
        let mut core = IndexingCore::open(path.to_str().expect("path"), &request).expect("core");
        core.accept_engine_group(&PhysicalGroup {
            group_sequence: 0,
            owners: vec![OwnerObservation {
                owner_artifact_id: "artifact:a".into(),
                owner_artifact_version_id: "version:a".into(),
                owner_path: "a.ts".into(),
                lane: "structural".into(),
                sequence: 0,
                final_batch: true,
                records: vec![StructuralKernelRecord {
                    proposal_record_key: "proposal:a".into(),
                    category: "entity".into(),
                    kind: "jsts:entity_variable".into(),
                    universal_kind: "core:variable".into(),
                    facets: "[]".into(),
                    schema_version: 1,
                    source_span: "{}".into(),
                    identity_key: "identity:a".into(),
                    body: json!({"name":"a"}),
                    evidence_references: "[]".into(),
                }],
                dependencies: vec![],
                byte_length: 0,
                owner_digest: String::new(),
                fact_delta_id: Some("jsts:delta:candidate:work:artifact:a".into()),
                delta_digest: Some("sha256:delta-a".into()),
            }],
        })
        .expect("group");
        let descriptor = core.seal(&request).expect("seal");
        core.publish(
            &request,
            &descriptor,
            &mut WorkspacePublicationSink { publication: None },
        )
        .expect("publish");
        let check = rusqlite::Connection::open(&path).expect("check db");
        let staged_rows: i64 = check
            .query_row("SELECT COUNT(*) FROM candidate_staged_records", [], |row| {
                row.get(0)
            })
            .expect("legacy staged row count");
        // Rust keeps canonical/body bytes only in its typed temporary staging
        // table; the legacy candidate row is not materialized on this path.
        assert_eq!(staged_rows, 0);
        let namespace: String = check
            .query_row(
                "SELECT fact_delta_id FROM candidate_fact_delta_namespaces WHERE owner_artifact_id = 'artifact:a'",
                [],
                |row| row.get(0),
            )
            .expect("owner namespace");
        assert_eq!(namespace, "jsts:delta:candidate:work:artifact:a");
        let delta_digest: String = check
            .query_row(
                "SELECT delta_digest FROM candidate_fact_deltas WHERE fact_delta_id = 'jsts:delta:candidate:work:artifact:a'",
                [],
                |row| row.get(0),
            )
            .expect("owner receipt digest");
        assert_eq!(delta_digest, "sha256:delta-a");
        let promoted: i64 = check
            .query_row(
                "SELECT COUNT(*) FROM candidate_publication_record_occurrences WHERE candidate_generation_id = 'candidate:worker-test'",
                [],
                |row| row.get(0),
            )
            .expect("promoted record");
        assert_eq!(promoted, 1);
        let identity: String = check
            .query_row(
                "SELECT identity_assignment_id FROM candidate_publication_identity_assignments WHERE candidate_generation_id = 'candidate:worker-test'",
                [],
                |row| row.get(0),
            )
            .expect("promoted identity");
        assert!(!identity.is_empty());
        let receipts_before: i64 = check
            .query_row(
                "SELECT COUNT(*) FROM candidate_fact_deltas WHERE candidate_generation_id = 'candidate:worker-test'",
                [],
                |row| row.get(0),
            )
            .expect("receipt count before rollback");
        drop(check);
        // Finalization is deliberately part of the sink transaction. An
        // invalid envelope must roll back the receipt/promotion writes made
        // earlier in that same transaction, rather than leaving a partial
        // candidate that a later retry would mistake for committed state.
        let failed = core.publish(
            &request,
            &descriptor,
            &mut WorkspacePublicationSink {
                publication: Some(json!({})),
            },
        );
        assert!(failed.is_err());
        let check = rusqlite::Connection::open(&path).expect("check rollback db");
        let receipts_after: i64 = check
            .query_row(
                "SELECT COUNT(*) FROM candidate_fact_deltas WHERE candidate_generation_id = 'candidate:worker-test'",
                [],
                |row| row.get(0),
            )
            .expect("receipt count after rollback");
        assert_eq!(receipts_after, receipts_before);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn engine_owned_jsts_capture_stages_without_host_fact_pages() {
        let request = test_request();
        let source_path = std::env::temp_dir().join(format!(
            "urdira-indexing-worker-source-{}.ts",
            std::process::id()
        ));
        let source = b"const answer = 42;\n";
        std::fs::write(&source_path, source).expect("source");
        let mut hasher = sha2::Sha256::new();
        hasher.update(source);
        let digest = format!(
            "sha256:{}",
            hasher
                .finalize()
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>()
        );
        let mut core = IndexingCore::open(":memory:", &request).expect("core");
        let mut syntax = SyntaxWorkerState::default();
        let mut engine = JavascriptTypescriptEngine::new("1", "sha256:engine");
        let input = serde_json::from_value::<JstsGenerationInput>(serde_json::json!({
            "project_key": "project:worker-test",
            "configuration_digest": "sha256:0000000000000000000000000000000000000000000000000000000000000000",
            "root_names": ["a.ts"],
            "files": [{
                "path": "a.ts",
                "artifact_id": "artifact:a",
                "artifact_version_id": "version:a",
                "content_digest": digest,
                "source_blob_path": source_path,
                "byte_length": source.len()
            }],
            "budgets": {"max_output_bytes": 16 * 1024 * 1024, "max_files": 1, "max_source_bytes": source.len()}
        }))
        .expect("engine input");
        let summary =
            run_jsts_generation(&mut syntax, &mut core, &mut engine, &request, &input, true)
                .expect("engine-owned generation");
        assert_eq!(summary.affected_paths, vec!["a.ts"]);
        assert_eq!(summary.group_count, 1);
        assert_eq!(core.recovered_group_count().expect("receipt count"), 1);
        let _ = std::fs::remove_file(source_path);
    }

    #[test]
    fn direct_generation_keeps_syntax_lane_when_semantic_envelope_is_present() {
        let mut request = test_request();
        request.direct_publication = true;
        let source_path = std::env::temp_dir().join(format!(
            "urdira-indexing-worker-semantic-source-{}.ts",
            std::process::id()
        ));
        let source = b"export const answer = 42;\n";
        std::fs::write(&source_path, source).expect("source");
        let digest = format!(
            "sha256:{}",
            sha2::Sha256::digest(source)
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>()
        );
        let mut core = IndexingCore::open(":memory:", &request).expect("core");
        let mut syntax = SyntaxWorkerState::default();
        let mut engine = JavascriptTypescriptEngine::new("1", "sha256:engine");
        let input = serde_json::from_value::<JstsGenerationInput>(serde_json::json!({
            "project_key": "project:worker-test-semantic",
            "configuration_digest": "sha256:0000000000000000000000000000000000000000000000000000000000000000",
            "root_names": ["a.ts"],
            "files": [{
                "path": "a.ts",
                "artifact_id": "artifact:a",
                "artifact_version_id": "version:a",
                "content_digest": digest,
                "source_blob_path": source_path,
                "byte_length": source.len()
            }],
            "budgets": {"max_output_bytes": 16 * 1024 * 1024, "max_files": 1, "max_source_bytes": source.len()},
            "semantic": {
                "inputs_digest": "sha256:inputs",
                "registry_digest": "sha256:registry",
                "plugin_id": "urdira:javascript_typescript",
                "plugin_version": "1",
                "analysis_digest": "sha256:analysis",
                "analysis_configuration_digest": "sha256:configuration",
                "stage_capabilities": ["core:call_relationships"],
                "stage_record_kinds": ["jsts:relation_call"],
                "publication_stage_id": "jsts:structural_stage_3",
                "created_at": "2030-01-01T00:00:00.000Z"
            }
        }))
        .expect("engine input");
        let summary =
            run_jsts_generation(&mut syntax, &mut core, &mut engine, &request, &input, true)
                .expect("direct generation");
        assert_eq!(summary.affected_paths, vec!["a.ts"]);
        assert_eq!(summary.group_count, 1);
        assert!(summary.row_count > 0);
        assert_eq!(core.recovered_group_count().expect("receipt count"), 1);
        let _ = std::fs::remove_file(source_path);
    }

    #[test]
    fn candidate_lifecycle_is_persisted_by_generic_rust_core() {
        let request = test_request();
        let mut core = IndexingCore::open(":memory:", &request).expect("core");
        core.with_transaction(|transaction| {
            transaction.execute_batch("CREATE TABLE candidate_state (candidate_generation_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, base_snapshot_id TEXT, base_generation INTEGER, base_registry_snapshot_id TEXT, target_registry_snapshot_id TEXT NOT NULL, base_configuration_revision_id TEXT, target_configuration_revision_id TEXT NOT NULL, trigger_kind TEXT NOT NULL, state TEXT NOT NULL, work_manifest_id TEXT, source_observation_batch_ids TEXT NOT NULL, retention_lease_id TEXT, candidate_materialization_id TEXT, candidate_digest TEXT, created_at TEXT NOT NULL, analysis_started_at TEXT, ready_at TEXT, finished_at TEXT, published_snapshot_id TEXT, published_generation INTEGER, generation_manifest_id TEXT, stale_against_snapshot_id TEXT, failure_code TEXT, issue_ids TEXT NOT NULL, frozen_snapshot_id TEXT, frozen_generation INTEGER, frozen_registry_snapshot_id TEXT, frozen_resolution_lock_id TEXT, frozen_configuration_revision_id TEXT, frozen_source_state_digest TEXT, frozen_source_observation_batch_ids TEXT, frozen_tuple_digest TEXT); CREATE TABLE candidate_work_manifests (work_manifest_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, candidate_generation_id TEXT NOT NULL, supersedes_work_manifest_id TEXT, base_snapshot_id TEXT, invalidation_plan_id TEXT NOT NULL, target_registry_snapshot_id TEXT NOT NULL, target_configuration_revision_id TEXT NOT NULL, artifact_work_set TEXT NOT NULL, projection_work_set TEXT NOT NULL, created_at TEXT NOT NULL, work_digest TEXT NOT NULL);") .map_err(sql_error)
        }).expect("schema");
        let candidate = json!({
            "candidate_generation_id": request.candidate_generation_id,
            "workspace_id": request.workspace_id,
            "target_registry_snapshot_id": request.registry_snapshot_id,
            "target_configuration_revision_id": request.configuration_revision_id,
            "trigger_kind": "full_reconciliation",
            "source_observation_batch_ids": [],
            "issue_ids": [],
            "created_at": "2030-01-01T00:00:00.000Z"
        });
        let frozen = json!({
            "source_state_digest": "sha256:source",
            "source_observation_batch_ids": [],
            "tuple_digest": "sha256:frozen"
        });
        let manifest = json!({
            "work_manifest_id": "manifest:worker-test",
            "candidate_generation_id": request.candidate_generation_id,
            "workspace_id": request.workspace_id,
            "invalidation_plan_id": "invalidation:worker-test",
            "target_registry_snapshot_id": request.registry_snapshot_id,
            "target_configuration_revision_id": request.configuration_revision_id,
            "artifact_work_set": {},
            "projection_work_set": {},
            "created_at": "2030-01-01T00:00:00.000Z",
            "work_digest": "sha256:manifest"
        });
        persist_candidate_lifecycle(
            &mut core,
            &request,
            Some(&candidate),
            Some(&frozen),
            Some(&manifest),
        )
        .expect("lifecycle");
        let state: String = core
            .with_transaction(|transaction| {
                transaction
                    .query_row(
                        "SELECT state FROM candidate_state WHERE candidate_generation_id = ?1",
                        [&request.candidate_generation_id],
                        |row| row.get(0),
                    )
                    .map_err(sql_error)
            })
            .expect("state");
        assert_eq!(state, "analyzing");
    }

    #[test]
    fn manifest_descriptor_normalizes_ordered_set_shape() {
        let descriptor = change_set_descriptor(
            r#"{"descriptor_id":"set:x","element_type":"core:CandidateRecordOpenTemplate","element_schema_version":"1","comparator_id":"core:lexicographic_uri","comparator_version":"1","entry_count":3,"content_digest":"sha256:abc"}"#,
            "core:record_open_set",
        );
        assert_eq!(descriptor["change_set_kind"], "core:record_open_set");
        assert_eq!(descriptor["entry_count"], 3);
        assert_eq!(descriptor["content_digest"], "sha256:abc");
        assert!(descriptor.get("element_type").is_none());
    }

    // --- F5 hybrid lane (E1b) ---------------------------------------------

    #[test]
    fn hybrid_flag_only_enables_on_the_exact_value_one() {
        // Pure-function test rather than a real env-var mutation: tests run
        // concurrently in this binary, so racing writes to a shared
        // `std::env` variable across tests would be flaky by construction.
        assert!(hybrid_semantics_enabled_from(None));
        assert!(hybrid_semantics_enabled_from(Some("")));
        assert!(hybrid_semantics_enabled_from(Some("true")));
        assert!(!hybrid_semantics_enabled_from(Some("0")));
        assert!(hybrid_semantics_enabled_from(Some("yes")));
        assert!(hybrid_semantics_enabled_from(Some("1")));
    }

    #[test]
    fn hybrid_strict_merge_defaults_to_the_hybrid_lanes_own_activation() {
        // No explicit override: strict mode tracks whether the cutover
        // itself is active -- collisions are only a real bug once the
        // checker has stopped double-covering pending sites.
        assert!(!hybrid_strict_merge_from(None, false));
        assert!(hybrid_strict_merge_from(None, true));
    }

    #[test]
    fn hybrid_strict_merge_explicit_override_always_wins() {
        assert!(hybrid_strict_merge_from(Some("1"), false));
        assert!(!hybrid_strict_merge_from(Some("0"), true));
        // Anything other than the exact value "1" reads as "off", matching
        // `hybrid_semantics_enabled_from`'s parsing rule.
        assert!(!hybrid_strict_merge_from(Some("true"), true));
    }

    fn synthetic_hybrid_owner() -> HybridOwnerIdentity {
        HybridOwnerIdentity {
            path: "a.ts".into(),
            artifact_id: "artifact:a".into(),
            artifact_version_id: "version:a".into(),
        }
    }

    fn synthetic_reference_record(identity_key: &str) -> ProposedRecord {
        ProposedRecord {
            proposal_record_key: format!("proposal:{identity_key}"),
            category: "relation",
            kind: "jsts:relation_references".into(),
            universal_kind: "core:references".into(),
            facets: "[]".into(),
            facets_list: Vec::new(),
            schema_version: 1,
            source_span: "{}".into(),
            // A4 (line numbers task): no real `LineIndex` behind this
            // synthetic fixture -- `0` is the documented "no line known"
            // sentinel.
            span_start_line: 0,
            span_end_line: 0,
            identity_key: identity_key.to_owned(),
            body: RecordBody::Value(
                json!({"source_id": "src", "target_id": "tgt", "classification": "confirmed"}),
            ),
            source_id: Some("src".into()),
            target_id: Some("tgt".into()),
            evidence_references: "[]".into(),
        }
    }

    fn synthetic_checker_observations(
        existing_identity_key: &str,
    ) -> Vec<urdira_indexing_core::CanonicalOwnerObservation> {
        vec![urdira_indexing_core::CanonicalOwnerObservation {
            owner_artifact_id: "artifact:a".into(),
            owner_artifact_version_id: "version:a".into(),
            owner_path: "a.ts".into(),
            lane: "semantic".into(),
            sequence: 0,
            final_batch: true,
            canonical_records: vec![format!(
                r#"{{"body":{{}},"category":"relation","evidence_references":"[]","facets":"[]","identity_key":"{existing_identity_key}","kind":"jsts:relation_diagnostic","proposal_record_key":"proposal:checker","schema_version":1,"source_span":"{{}}","universal_kind":"core:diagnostic"}}"#
            )],
            canonical_dependencies: vec![],
            byte_length: 0,
            owner_digest: String::new(),
            fact_delta_id: None,
            delta_digest: None,
            diagnostic_codes: vec![],
        }]
    }

    #[test]
    fn merge_strict_mode_fails_closed_on_identity_key_collision() {
        let key = "jsts:references:a.ts:5:10:src:tgt";
        let mut observations = synthetic_checker_observations(key);
        let semantics = OwnerSemantics {
            reference_rows: vec![synthetic_reference_record(key)],
            covers_rows: vec![],
            call_rows: vec![],
            heritage_rows: vec![],
            typeflow_call_rows: vec![],
            typeflow_heritage_rows: vec![],
            pending_site_rows: vec![],
            candidate_call_rows: vec![],
            parameter_entity_rows: vec![],
            parameter_contains_rows: vec![],
            external_entity_rows: vec![],
            external_contains_rows: vec![],
            typeflow_oracle_hits: vec![],
            typeflow_pending_call_shapes: vec![],
            pending_sites: vec![],
            sites_digest: "jsts:sites:sha256:test".into(),
            jsdoc_typed_file: false,
            ambient_global_dependencies: vec![],
        };
        let owner = synthetic_hybrid_owner();
        let error = merge_hybrid_reference_rows(&mut observations, &semantics, &owner, true)
            .expect_err("a proven double emission must fail the generation closed");
        assert!(
            error.0.contains(key),
            "error should name the offending identity_key: {}",
            error.0
        );
        // Strict mode must not have merged the colliding row before failing.
        assert_eq!(observations[0].canonical_records.len(), 1);
    }

    #[test]
    fn merge_dry_mode_counts_the_collision_and_skips_the_row() {
        let key = "jsts:references:a.ts:5:10:src:tgt";
        let mut observations = synthetic_checker_observations(key);
        let semantics = OwnerSemantics {
            reference_rows: vec![synthetic_reference_record(key)],
            covers_rows: vec![],
            call_rows: vec![],
            heritage_rows: vec![],
            typeflow_call_rows: vec![],
            typeflow_heritage_rows: vec![],
            pending_site_rows: vec![],
            candidate_call_rows: vec![],
            parameter_entity_rows: vec![],
            parameter_contains_rows: vec![],
            external_entity_rows: vec![],
            external_contains_rows: vec![],
            typeflow_oracle_hits: vec![],
            typeflow_pending_call_shapes: vec![],
            pending_sites: vec![],
            sites_digest: "jsts:sites:sha256:test".into(),
            jsdoc_typed_file: false,
            ambient_global_dependencies: vec![],
        };
        let owner = synthetic_hybrid_owner();
        let stats = merge_hybrid_reference_rows(&mut observations, &semantics, &owner, false)
            .expect("dry mode completes the generation instead of failing it");
        assert_eq!(stats.attempted, 1);
        assert_eq!(stats.collisions, 1);
        assert_eq!(stats.merged, 0);
        assert_eq!(stats.example_collision_key.as_deref(), Some(key));
        // The colliding row must never be merged, or the checker's own row
        // for the same identity_key would be double-published.
        assert_eq!(observations[0].canonical_records.len(), 1);
    }

    #[test]
    fn merge_appends_non_colliding_rows_to_the_final_observation() {
        let existing_key = "jsts:references:a.ts:1:2:src:other";
        let new_key = "jsts:references:a.ts:5:10:src:tgt";
        let mut observations = synthetic_checker_observations(existing_key);
        let semantics = OwnerSemantics {
            reference_rows: vec![synthetic_reference_record(new_key)],
            covers_rows: vec![],
            call_rows: vec![],
            heritage_rows: vec![],
            typeflow_call_rows: vec![],
            typeflow_heritage_rows: vec![],
            pending_site_rows: vec![],
            candidate_call_rows: vec![],
            parameter_entity_rows: vec![],
            parameter_contains_rows: vec![],
            external_entity_rows: vec![],
            external_contains_rows: vec![],
            typeflow_oracle_hits: vec![],
            typeflow_pending_call_shapes: vec![],
            pending_sites: vec![],
            sites_digest: "jsts:sites:sha256:test".into(),
            jsdoc_typed_file: false,
            ambient_global_dependencies: vec![],
        };
        let owner = synthetic_hybrid_owner();
        let stats = merge_hybrid_reference_rows(&mut observations, &semantics, &owner, true)
            .expect("no collision merges cleanly even in strict mode");
        assert_eq!(stats.attempted, 1);
        assert_eq!(stats.collisions, 0);
        assert_eq!(stats.merged, 1);
        assert_eq!(observations[0].canonical_records.len(), 2);
        let merged_row: Value = serde_json::from_str(&observations[0].canonical_records[1])
            .expect("merged row is valid canonical JSON");
        assert_eq!(merged_row["identity_key"], new_key);
        assert_eq!(merged_row["universal_kind"], "core:references");
    }

    fn synthetic_covers_record(identity_key: &str) -> ProposedRecord {
        ProposedRecord {
            proposal_record_key: format!("proposal:{identity_key}"),
            category: "relation",
            kind: "jsts:relation_covers".into(),
            universal_kind: "core:covers".into(),
            facets: "[]".into(),
            facets_list: Vec::new(),
            schema_version: 1,
            source_span: "{}".into(),
            span_start_line: 0,
            span_end_line: 0,
            identity_key: identity_key.to_owned(),
            body: RecordBody::Value(
                json!({"source_id": "test_module", "target_id": "tgt", "classification": "confirmed"}),
            ),
            source_id: Some("test_module".into()),
            target_id: Some("tgt".into()),
            evidence_references: "[]".into(),
        }
    }

    /// `core:covers` rows (F5 hybrid gap fix, 2026-09-01) merge through the
    /// exact same non-colliding path as `core:references` rows -- appended
    /// to the owner's canonical observations, counted in `stats`.
    #[test]
    fn merge_appends_a_non_colliding_covers_row_alongside_reference_rows() {
        let existing_key = "jsts:diagnostic:a.ts:0:TS0";
        let reference_key = "jsts:references:a.ts:5:10:src:tgt";
        let covers_key = "jsts:covers:a.ts:5:10:test_module:tgt";
        let mut observations = synthetic_checker_observations(existing_key);
        let semantics = OwnerSemantics {
            reference_rows: vec![synthetic_reference_record(reference_key)],
            covers_rows: vec![synthetic_covers_record(covers_key)],
            call_rows: vec![],
            heritage_rows: vec![],
            typeflow_call_rows: vec![],
            typeflow_heritage_rows: vec![],
            pending_site_rows: vec![],
            candidate_call_rows: vec![],
            parameter_entity_rows: vec![],
            parameter_contains_rows: vec![],
            external_entity_rows: vec![],
            external_contains_rows: vec![],
            typeflow_oracle_hits: vec![],
            typeflow_pending_call_shapes: vec![],
            pending_sites: vec![],
            sites_digest: "jsts:sites:sha256:test".into(),
            jsdoc_typed_file: false,
            ambient_global_dependencies: vec![],
        };
        let owner = synthetic_hybrid_owner();
        let stats = merge_hybrid_reference_rows(&mut observations, &semantics, &owner, true)
            .expect("non-colliding reference and covers rows merge cleanly");
        assert_eq!(stats.attempted, 2);
        assert_eq!(stats.collisions, 0);
        assert_eq!(stats.merged, 2);
        assert_eq!(observations[0].canonical_records.len(), 3);
        let merged: Vec<Value> = observations[0].canonical_records[1..]
            .iter()
            .map(|row| serde_json::from_str(row).expect("merged row is valid canonical JSON"))
            .collect();
        assert!(merged.iter().any(|row| row["identity_key"] == reference_key
            && row["universal_kind"] == "core:references"));
        assert!(
            merged
                .iter()
                .any(|row| row["identity_key"] == covers_key
                    && row["universal_kind"] == "core:covers"),
            "the covers row must be merged in alongside the reference row: {merged:?}"
        );
    }

    /// The gate's dedup case: the checker independently derived a
    /// `core:covers` row for the same `testContainer -> target` pair (e.g.
    /// through a different, checker-resolved reference that happens to
    /// collapse to the identical `identity_key` -- see `OwnerSemantics::
    /// covers_rows`'s doc comment on why the partition invariant makes a
    /// genuine collision here exceptional, not the common case). The merge
    /// must still keep exactly one row for that identity, never two.
    #[test]
    fn merge_dedupes_a_covers_row_that_collides_with_an_existing_checker_derived_covers_row() {
        let key = "jsts:covers:a.ts:5:10:test_module:tgt";
        let mut observations = vec![urdira_indexing_core::CanonicalOwnerObservation {
            owner_artifact_id: "artifact:a".into(),
            owner_artifact_version_id: "version:a".into(),
            owner_path: "a.ts".into(),
            lane: "semantic".into(),
            sequence: 0,
            final_batch: true,
            canonical_records: vec![format!(
                r#"{{"body":{{"source_id":"test_module","target_id":"tgt","classification":"confirmed"}},"category":"relation","evidence_references":"[]","facets":"[]","identity_key":"{key}","kind":"jsts:relation_covers","proposal_record_key":"proposal:checker","schema_version":1,"source_span":"{{}}","universal_kind":"core:covers"}}"#
            )],
            canonical_dependencies: vec![],
            byte_length: 0,
            owner_digest: String::new(),
            fact_delta_id: None,
            delta_digest: None,
            diagnostic_codes: vec![],
        }];
        let semantics = OwnerSemantics {
            reference_rows: vec![],
            covers_rows: vec![synthetic_covers_record(key)],
            call_rows: vec![],
            heritage_rows: vec![],
            typeflow_call_rows: vec![],
            typeflow_heritage_rows: vec![],
            pending_site_rows: vec![],
            candidate_call_rows: vec![],
            parameter_entity_rows: vec![],
            parameter_contains_rows: vec![],
            external_entity_rows: vec![],
            external_contains_rows: vec![],
            typeflow_oracle_hits: vec![],
            typeflow_pending_call_shapes: vec![],
            pending_sites: vec![],
            sites_digest: "jsts:sites:sha256:test".into(),
            jsdoc_typed_file: false,
            ambient_global_dependencies: vec![],
        };
        let owner = synthetic_hybrid_owner();
        let stats = merge_hybrid_reference_rows(&mut observations, &semantics, &owner, false)
            .expect("dry mode completes instead of failing on a covers identity collision");
        assert_eq!(stats.attempted, 1);
        assert_eq!(stats.collisions, 1);
        assert_eq!(stats.merged, 0);
        assert_eq!(stats.example_collision_key.as_deref(), Some(key));
        assert_eq!(
            observations[0].canonical_records.len(),
            1,
            "exactly one row must survive for this identity_key, never two"
        );
    }

    #[test]
    fn merge_synthesizes_an_observation_when_the_owner_has_no_checker_batches() {
        let mut observations: Vec<urdira_indexing_core::CanonicalOwnerObservation> = Vec::new();
        let key = "jsts:references:a.ts:5:10:src:tgt";
        let semantics = OwnerSemantics {
            reference_rows: vec![synthetic_reference_record(key)],
            covers_rows: vec![],
            call_rows: vec![],
            heritage_rows: vec![],
            typeflow_call_rows: vec![],
            typeflow_heritage_rows: vec![],
            pending_site_rows: vec![],
            candidate_call_rows: vec![],
            parameter_entity_rows: vec![],
            parameter_contains_rows: vec![],
            external_entity_rows: vec![],
            external_contains_rows: vec![],
            typeflow_oracle_hits: vec![],
            typeflow_pending_call_shapes: vec![],
            pending_sites: vec![],
            sites_digest: "jsts:sites:sha256:test".into(),
            jsdoc_typed_file: false,
            ambient_global_dependencies: vec![],
        };
        let owner = synthetic_hybrid_owner();
        let stats = merge_hybrid_reference_rows(&mut observations, &semantics, &owner, true)
            .expect("merge succeeds by synthesizing a fresh observation");
        assert_eq!(stats.merged, 1);
        assert_eq!(observations.len(), 1);
        assert_eq!(observations[0].owner_path, "a.ts");
        assert_eq!(observations[0].canonical_records.len(), 1);
    }

    /// A single-page checker observation carrying `row_count` distinct
    /// `core:diagnostic` rows (never `core:references`, so they never
    /// collide with the synthetic hybrid reference rows below). Used to
    /// build an owner whose checker output already sits close to the
    /// `MAX_GROUP_ROWS` bound before any hybrid rows are merged in.
    fn synthetic_checker_observation_with_rows(
        row_count: usize,
    ) -> Vec<urdira_indexing_core::CanonicalOwnerObservation> {
        vec![urdira_indexing_core::CanonicalOwnerObservation {
            owner_artifact_id: "artifact:a".into(),
            owner_artifact_version_id: "version:a".into(),
            owner_path: "a.ts".into(),
            lane: "semantic".into(),
            sequence: 0,
            final_batch: true,
            canonical_records: (0..row_count)
                .map(|index| {
                    format!(
                        r#"{{"body":{{}},"category":"relation","evidence_references":"[]","facets":"[]","identity_key":"jsts:checker:{index}","kind":"jsts:relation_diagnostic","proposal_record_key":"proposal:checker:{index}","schema_version":1,"source_span":"{{}}","universal_kind":"core:diagnostic"}}"#
                    )
                })
                .collect(),
            canonical_dependencies: vec![],
            byte_length: 0,
            owner_digest: String::new(),
            fact_delta_id: None,
            delta_digest: None,
            diagnostic_codes: vec![],
        }]
    }

    /// `hybrid_row_count` distinct `core:references` proposals, none of
    /// which collide with `synthetic_checker_observation_with_rows`'s
    /// identity keys (or each other).
    fn synthetic_hybrid_reference_rows(hybrid_row_count: usize) -> Vec<ProposedRecord> {
        (0..hybrid_row_count)
            .map(|index| {
                synthetic_reference_record(&format!("jsts:references:a.ts:hybrid:{index}"))
            })
            .collect()
    }

    fn total_observation_rows(
        observations: &[urdira_indexing_core::CanonicalOwnerObservation],
    ) -> usize {
        observations
            .iter()
            .map(|observation| {
                observation.canonical_records.len() + observation.canonical_dependencies.len()
            })
            .sum()
    }

    #[test]
    fn merge_pages_a_giant_owner_instead_of_exceeding_the_row_bound() {
        // Reproduces the n8n `generate-types.ts` failure: checker rows near
        // the 4,096-row physical bound, plus hybrid rows that alone would
        // push the owner's final observation past it. Regression test for
        // "core:engine_failed: owner ... rejected: Structural canonical
        // batch exceeds the 4096-row bound".
        let max_rows = urdira_indexing_core::MAX_GROUP_ROWS;
        let existing_rows = max_rows - 10;
        let hybrid_rows = 50;
        let mut observations = synthetic_checker_observation_with_rows(existing_rows);
        let reference_rows = synthetic_hybrid_reference_rows(hybrid_rows);
        let semantics = OwnerSemantics {
            reference_rows,
            covers_rows: vec![],
            call_rows: vec![],
            heritage_rows: vec![],
            typeflow_call_rows: vec![],
            typeflow_heritage_rows: vec![],
            pending_site_rows: vec![],
            candidate_call_rows: vec![],
            parameter_entity_rows: vec![],
            parameter_contains_rows: vec![],
            external_entity_rows: vec![],
            external_contains_rows: vec![],
            typeflow_oracle_hits: vec![],
            typeflow_pending_call_shapes: vec![],
            pending_sites: vec![],
            sites_digest: "jsts:sites:sha256:test".into(),
            jsdoc_typed_file: false,
            ambient_global_dependencies: vec![],
        };
        let owner = synthetic_hybrid_owner();
        let stats = merge_hybrid_reference_rows(&mut observations, &semantics, &owner, true)
            .expect("hybrid rows must page instead of overflowing a single observation");
        assert_eq!(stats.merged, hybrid_rows);
        assert_eq!(
            total_observation_rows(&observations),
            existing_rows + hybrid_rows
        );

        // Every observation individually respects the physical bound that
        // `structural_kernel_canonical_batch_parts_with_records` enforces at
        // acceptance time.
        for observation in &observations {
            assert!(
                observation.canonical_records.len() + observation.canonical_dependencies.len()
                    <= max_rows,
                "observation sequence {} exceeds the row bound",
                observation.sequence
            );
        }

        // Splitting must behave like a checker cursor continuation: strictly
        // increasing, contiguous sequence numbers for the same owner
        // identity, with `final_batch` true on exactly the last page.
        assert!(observations.len() > 1, "the owner must have paged");
        for (index, observation) in observations.iter().enumerate() {
            assert_eq!(observation.sequence, index as u64);
            assert_eq!(observation.owner_artifact_id, "artifact:a");
            assert_eq!(observation.owner_artifact_version_id, "version:a");
            assert_eq!(observation.owner_path, "a.ts");
            let is_last = index + 1 == observations.len();
            assert_eq!(
                observation.final_batch, is_last,
                "only the last page should carry final_batch=true"
            );
        }

        // The first page must have been topped off to the bound rather than
        // split evenly, and the overflow lands entirely on the new page.
        assert_eq!(observations[0].canonical_records.len(), max_rows);
        assert_eq!(
            observations[1].canonical_records.len(),
            existing_rows + hybrid_rows - max_rows
        );
    }

    #[test]
    fn merge_does_not_page_when_the_owner_lands_exactly_on_the_row_bound() {
        let max_rows = urdira_indexing_core::MAX_GROUP_ROWS;
        let existing_rows = max_rows - 6;
        let hybrid_rows = 6;
        let mut observations = synthetic_checker_observation_with_rows(existing_rows);
        let reference_rows = synthetic_hybrid_reference_rows(hybrid_rows);
        let semantics = OwnerSemantics {
            reference_rows,
            covers_rows: vec![],
            call_rows: vec![],
            heritage_rows: vec![],
            typeflow_call_rows: vec![],
            typeflow_heritage_rows: vec![],
            pending_site_rows: vec![],
            candidate_call_rows: vec![],
            parameter_entity_rows: vec![],
            parameter_contains_rows: vec![],
            external_entity_rows: vec![],
            external_contains_rows: vec![],
            typeflow_oracle_hits: vec![],
            typeflow_pending_call_shapes: vec![],
            pending_sites: vec![],
            sites_digest: "jsts:sites:sha256:test".into(),
            jsdoc_typed_file: false,
            ambient_global_dependencies: vec![],
        };
        let owner = synthetic_hybrid_owner();
        let stats = merge_hybrid_reference_rows(&mut observations, &semantics, &owner, true)
            .expect("an owner landing exactly on the bound must not error");
        assert_eq!(stats.merged, hybrid_rows);
        // Exactly at the limit: still one observation, no page opened, and
        // `final_batch` is untouched (byte-identical to the pre-fix
        // unconditional extend for this non-overflowing shape).
        assert_eq!(observations.len(), 1);
        assert_eq!(observations[0].canonical_records.len(), max_rows);
        assert!(observations[0].final_batch);
    }

    /// A single-page checker observation carrying `row_count` distinct
    /// `core:diagnostic` rows, each padded with `padding_bytes` of body
    /// filler so the observation's total byte length -- not just its row
    /// count -- can be driven close to `MAX_BATCH_FRAMED_BYTES`.
    fn synthetic_checker_observation_with_padded_rows(
        row_count: usize,
        padding_bytes: usize,
    ) -> Vec<urdira_indexing_core::CanonicalOwnerObservation> {
        let padding = "x".repeat(padding_bytes);
        vec![urdira_indexing_core::CanonicalOwnerObservation {
            owner_artifact_id: "artifact:a".into(),
            owner_artifact_version_id: "version:a".into(),
            owner_path: "a.ts".into(),
            lane: "semantic".into(),
            sequence: 0,
            final_batch: true,
            canonical_records: (0..row_count)
                .map(|index| {
                    format!(
                        r#"{{"body":{{"padding":"{padding}"}},"category":"relation","evidence_references":"[]","facets":"[]","identity_key":"jsts:checker:padded:{index}","kind":"jsts:relation_diagnostic","proposal_record_key":"proposal:checker:padded:{index}","schema_version":1,"source_span":"{{}}","universal_kind":"core:diagnostic"}}"#
                    )
                })
                .collect(),
            canonical_dependencies: vec![],
            byte_length: 0,
            owner_digest: String::new(),
            fact_delta_id: None,
            delta_digest: None,
            diagnostic_codes: vec![],
        }]
    }

    /// `hybrid_row_count` distinct `core:references` proposals, each padded
    /// with `padding_bytes` of body filler, staying well under both
    /// `MAX_BATCH_RECORDS` and `MAX_BATCH_FRAMED_BYTES` on their own so the
    /// upfront `structural_kernel_batch_parts` seal in
    /// `merge_hybrid_reference_rows` (which canonicalizes every hybrid row
    /// for the owner in one shot, before any pagination) never rejects them
    /// by itself -- only the *combination* with the existing checker
    /// observation should overflow.
    fn synthetic_padded_hybrid_reference_rows(
        hybrid_row_count: usize,
        padding_bytes: usize,
    ) -> Vec<ProposedRecord> {
        (0..hybrid_row_count)
            .map(|index| {
                let mut record = synthetic_reference_record(&format!(
                    "jsts:references:a.ts:hybrid:padded:{index}"
                ));
                if let RecordBody::Value(Value::Object(body)) = &mut record.body {
                    body.insert("padding".into(), Value::String("x".repeat(padding_bytes)));
                }
                record
            })
            .collect()
    }

    #[test]
    fn merge_pages_a_giant_owner_instead_of_exceeding_the_byte_bound() {
        // Same production shape as the row-bound regression above, but this
        // owner's rows are individually large: bytes overflow the
        // native-core per-observation byte bound (`MAX_BATCH_FRAMED_BYTES`,
        // 4 MiB) long before row count anywhere approaches
        // `MAX_BATCH_RECORDS` (4,096). Regression test for the follow-on
        // failure once the row bound alone was fixed but this function was
        // still budgeting bytes against the *group* bound (16 MiB) instead
        // of the real per-observation bound: "core:engine_failed: owner ...
        // rejected: Structural canonical batch exceeds the 4194304-byte
        // bound".
        let max_rows = urdira_indexing_core::MAX_BATCH_RECORDS;
        let max_bytes = urdira_indexing_core::MAX_BATCH_FRAMED_BYTES;
        let row_padding_bytes = 40_000; // ~40 KiB of body filler per row.
        let existing_row_count = 60; // ~2.4 MiB of checker rows alone.
        let hybrid_row_count = 60; // ~2.4 MiB of hybrid rows alone.
        // Neither side alone crosses either bound; only the sum (~4.8 MiB,
        // 120 rows) crosses the byte bound -- and only the byte bound, since
        // 120 rows is nowhere near the 4,096-row bound. This exercises the
        // byte budget in isolation from the row budget already covered
        // above.
        let mut observations =
            synthetic_checker_observation_with_padded_rows(existing_row_count, row_padding_bytes);
        let reference_rows =
            synthetic_padded_hybrid_reference_rows(hybrid_row_count, row_padding_bytes);
        let semantics = OwnerSemantics {
            reference_rows,
            covers_rows: vec![],
            call_rows: vec![],
            heritage_rows: vec![],
            typeflow_call_rows: vec![],
            typeflow_heritage_rows: vec![],
            pending_site_rows: vec![],
            candidate_call_rows: vec![],
            parameter_entity_rows: vec![],
            parameter_contains_rows: vec![],
            external_entity_rows: vec![],
            external_contains_rows: vec![],
            typeflow_oracle_hits: vec![],
            typeflow_pending_call_shapes: vec![],
            pending_sites: vec![],
            sites_digest: "jsts:sites:sha256:test".into(),
            jsdoc_typed_file: false,
            ambient_global_dependencies: vec![],
        };
        let owner = synthetic_hybrid_owner();
        let stats = merge_hybrid_reference_rows(&mut observations, &semantics, &owner, true)
            .expect("large-bodied hybrid rows must page on bytes instead of overflowing a single observation");
        assert_eq!(stats.merged, hybrid_row_count);
        assert_eq!(
            total_observation_rows(&observations),
            existing_row_count + hybrid_row_count
        );
        assert!(
            observations.len() > 1,
            "byte overflow must have opened at least one extra page"
        );

        // Every observation individually respects both physical bounds that
        // `structural_kernel_canonical_batch_parts_with_records` enforces at
        // acceptance time, sequences are contiguous, and only the last page
        // is final -- the same invariants the row-bound test above checks,
        // now under a byte-driven split.
        let mut seen_identity_keys = HashSet::new();
        for (index, observation) in observations.iter().enumerate() {
            let rows =
                observation.canonical_records.len() + observation.canonical_dependencies.len();
            let bytes: usize = observation
                .canonical_records
                .iter()
                .chain(observation.canonical_dependencies.iter())
                .map(String::len)
                .sum();
            assert!(
                rows <= max_rows,
                "observation {index} exceeds the row bound: {rows}"
            );
            assert!(
                bytes <= max_bytes,
                "observation {index} exceeds the byte bound: {bytes}"
            );
            assert_eq!(observation.sequence, index as u64);
            assert_eq!(observation.owner_artifact_id, "artifact:a");
            assert_eq!(observation.owner_artifact_version_id, "version:a");
            assert_eq!(observation.owner_path, "a.ts");
            let is_last = index + 1 == observations.len();
            assert_eq!(
                observation.final_batch, is_last,
                "only the last page should carry final_batch=true"
            );
            for row in &observation.canonical_records {
                let parsed: Value = serde_json::from_str(row).expect("canonical row is valid JSON");
                let key = parsed["identity_key"]
                    .as_str()
                    .expect("every row carries an identity_key")
                    .to_owned();
                assert!(
                    seen_identity_keys.insert(key.clone()),
                    "identity_key {key} duplicated across pages"
                );
            }
        }
        assert_eq!(
            seen_identity_keys.len(),
            existing_row_count + hybrid_row_count
        );
    }

    #[test]
    fn merge_canonicalizes_and_pages_hybrid_rows_exceeding_the_row_bound_in_one_owner() {
        // Distinct from `merge_pages_a_giant_owner_instead_of_exceeding_the_row_bound`
        // above: that test's *hybrid* row count (50) stays far under
        // `MAX_BATCH_RECORDS` and only the *combination* with pre-existing
        // checker rows overflows once paginated. Here the hybrid rows
        // ALONE -- before any pagination against checker rows is even
        // reached -- exceed `MAX_BATCH_RECORDS`, which used to fail the
        // single upfront `structural_kernel_batch_parts` canonicalization
        // call inside `merge_hybrid_reference_rows` itself: "hybrid
        // reference row canonicalization failed for ...: Structural kernel
        // batch exceeds the 4096-row bound." (n8n
        // `useCanvasOperations.test.ts` under the F5 hybrid lane.)
        let max_rows = urdira_indexing_core::MAX_BATCH_RECORDS;
        let hybrid_row_count = max_rows + 500;
        let mut observations = synthetic_checker_observations("jsts:checker:only");
        let checker_row = observations[0].canonical_records[0].clone();
        let reference_rows = synthetic_hybrid_reference_rows(hybrid_row_count);
        let semantics = OwnerSemantics {
            reference_rows,
            covers_rows: vec![],
            call_rows: vec![],
            heritage_rows: vec![],
            typeflow_call_rows: vec![],
            typeflow_heritage_rows: vec![],
            pending_site_rows: vec![],
            candidate_call_rows: vec![],
            parameter_entity_rows: vec![],
            parameter_contains_rows: vec![],
            external_entity_rows: vec![],
            external_contains_rows: vec![],
            typeflow_oracle_hits: vec![],
            typeflow_pending_call_shapes: vec![],
            pending_sites: vec![],
            sites_digest: "jsts:sites:sha256:test".into(),
            jsdoc_typed_file: false,
            ambient_global_dependencies: vec![],
        };
        let owner = synthetic_hybrid_owner();
        let stats = merge_hybrid_reference_rows(&mut observations, &semantics, &owner, true).expect(
            "hybrid rows alone exceeding MAX_BATCH_RECORDS must canonicalize across multiple kernel calls, not fail",
        );
        assert_eq!(stats.merged, hybrid_row_count);

        // Every hybrid row this merge produced, in owner-observation order,
        // with the one pre-existing (untouched) checker row removed.
        let mut hybrid_canonical: Vec<String> = observations
            .iter()
            .flat_map(|observation| observation.canonical_records.iter().cloned())
            .collect();
        let checker_index = hybrid_canonical
            .iter()
            .position(|row| row == &checker_row)
            .expect("original checker row must still be present, unmodified");
        hybrid_canonical.remove(checker_index);
        assert_eq!(hybrid_canonical.len(), hybrid_row_count);

        // Ground truth: canonicalizing each hybrid record alone (a
        // one-record batch always sits within both bounds) is exactly what
        // any batch membership produces for that record, since per-record
        // canonical text never depends on which other rows share its batch
        // (see `canonicalize_structural_records_bounded`'s doc comment) --
        // i.e. exactly what the unbounded single-call path would have
        // produced, had it not been bound-limited.
        let expected: Vec<String> = synthetic_hybrid_reference_rows(hybrid_row_count)
            .iter()
            .map(hybrid_structural_record)
            .map(|record| {
                urdira_indexing_core::structural_kernel_batch_parts(
                    std::slice::from_ref(&record),
                    &[],
                )
                .expect("single-record batch always canonicalizes")
                .canonical_records
                .remove(0)
            })
            .collect();
        assert_eq!(
            hybrid_canonical, expected,
            "canonical rows and their order must match the unbounded (single-call) path, row for row"
        );

        // Row overflow paginated across more than one observation, and
        // every page individually respects the row bound.
        assert!(
            observations.len() > 1,
            "row overflow must have opened extra pages"
        );
        for observation in &observations {
            assert!(observation.canonical_records.len() <= max_rows);
        }
    }

    #[test]
    fn merge_canonicalizes_and_pages_hybrid_rows_exceeding_the_byte_bound_in_one_owner() {
        // Byte-bound counterpart to the row-bound test above: hybrid rows
        // alone stay far under `MAX_BATCH_RECORDS` but their combined
        // framed size exceeds `MAX_BATCH_FRAMED_BYTES`, which used to fail
        // the single upfront canonicalization call with "Structural kernel
        // batch exceeds the 4194304-byte bound" -- before any pagination
        // against the owner's checker rows was even reached.
        let max_bytes = urdira_indexing_core::MAX_BATCH_FRAMED_BYTES;
        let max_rows = urdira_indexing_core::MAX_BATCH_RECORDS;
        let padding_bytes = 30_000;
        let hybrid_row_count = 200; // ~6 MiB of hybrid rows, far under 4,096 rows.
        assert!(hybrid_row_count < max_rows);
        let mut observations = synthetic_checker_observations("jsts:checker:only");
        let checker_row = observations[0].canonical_records[0].clone();
        let reference_rows =
            synthetic_padded_hybrid_reference_rows(hybrid_row_count, padding_bytes);
        let semantics = OwnerSemantics {
            reference_rows,
            covers_rows: vec![],
            call_rows: vec![],
            heritage_rows: vec![],
            typeflow_call_rows: vec![],
            typeflow_heritage_rows: vec![],
            pending_site_rows: vec![],
            candidate_call_rows: vec![],
            parameter_entity_rows: vec![],
            parameter_contains_rows: vec![],
            external_entity_rows: vec![],
            external_contains_rows: vec![],
            typeflow_oracle_hits: vec![],
            typeflow_pending_call_shapes: vec![],
            pending_sites: vec![],
            sites_digest: "jsts:sites:sha256:test".into(),
            jsdoc_typed_file: false,
            ambient_global_dependencies: vec![],
        };
        let owner = synthetic_hybrid_owner();
        let stats = merge_hybrid_reference_rows(&mut observations, &semantics, &owner, true).expect(
            "hybrid rows alone exceeding MAX_BATCH_FRAMED_BYTES must canonicalize across multiple kernel calls, not fail",
        );
        assert_eq!(stats.merged, hybrid_row_count);

        let mut hybrid_canonical: Vec<String> = observations
            .iter()
            .flat_map(|observation| observation.canonical_records.iter().cloned())
            .collect();
        let checker_index = hybrid_canonical
            .iter()
            .position(|row| row == &checker_row)
            .expect("original checker row must still be present, unmodified");
        hybrid_canonical.remove(checker_index);
        assert_eq!(hybrid_canonical.len(), hybrid_row_count);

        let expected: Vec<String> =
            synthetic_padded_hybrid_reference_rows(hybrid_row_count, padding_bytes)
                .iter()
                .map(hybrid_structural_record)
                .map(|record| {
                    urdira_indexing_core::structural_kernel_batch_parts(
                        std::slice::from_ref(&record),
                        &[],
                    )
                    .expect("single-record batch always canonicalizes")
                    .canonical_records
                    .remove(0)
                })
                .collect();
        assert_eq!(
            hybrid_canonical, expected,
            "canonical rows and their order must match the unbounded (single-call) path, row for row"
        );

        assert!(
            observations.len() > 1,
            "byte overflow must have opened extra pages"
        );
        for observation in &observations {
            let bytes: usize = observation.canonical_records.iter().map(String::len).sum();
            assert!(
                bytes <= max_bytes,
                "observation exceeds the byte bound: {bytes}"
            );
        }
    }

    #[test]
    fn merge_is_a_no_op_when_the_owner_has_no_reference_rows() {
        let mut observations = synthetic_checker_observations("jsts:references:a.ts:1:2:src:other");
        let semantics = OwnerSemantics {
            reference_rows: vec![],
            covers_rows: vec![],
            call_rows: vec![],
            heritage_rows: vec![],
            typeflow_call_rows: vec![],
            typeflow_heritage_rows: vec![],
            pending_site_rows: vec![],
            candidate_call_rows: vec![],
            parameter_entity_rows: vec![],
            parameter_contains_rows: vec![],
            external_entity_rows: vec![],
            external_contains_rows: vec![],
            typeflow_oracle_hits: vec![],
            typeflow_pending_call_shapes: vec![],
            pending_sites: vec![],
            sites_digest: "jsts:sites:sha256:empty".into(),
            jsdoc_typed_file: false,
            ambient_global_dependencies: vec![],
        };
        let owner = synthetic_hybrid_owner();
        let stats = merge_hybrid_reference_rows(&mut observations, &semantics, &owner, true)
            .expect("an owner with nothing to merge always succeeds");
        assert_eq!(stats.attempted, 0);
        assert_eq!(stats.merged, 0);
        assert_eq!(observations[0].canonical_records.len(), 1);
    }

    #[test]
    fn hybrid_owner_can_skip_checker_when_nothing_is_pending_and_no_stage_three() {
        let semantics = OwnerSemantics {
            reference_rows: vec![],
            covers_rows: vec![],
            call_rows: vec![],
            heritage_rows: vec![],
            typeflow_call_rows: vec![],
            typeflow_heritage_rows: vec![],
            pending_site_rows: vec![],
            candidate_call_rows: vec![],
            parameter_entity_rows: vec![],
            parameter_contains_rows: vec![],
            external_entity_rows: vec![],
            external_contains_rows: vec![],
            typeflow_oracle_hits: vec![],
            typeflow_pending_call_shapes: vec![],
            pending_sites: vec![],
            sites_digest: "jsts:sites:sha256:empty".into(),
            jsdoc_typed_file: false,
            ambient_global_dependencies: vec![],
        };
        assert!(hybrid_owner_can_skip_checker(&semantics, false, false));
    }

    #[test]
    fn hybrid_owner_cannot_skip_checker_when_sites_are_still_pending() {
        let semantics = OwnerSemantics {
            reference_rows: vec![],
            covers_rows: vec![],
            call_rows: vec![],
            heritage_rows: vec![],
            typeflow_call_rows: vec![],
            typeflow_heritage_rows: vec![],
            pending_site_rows: vec![],
            candidate_call_rows: vec![],
            parameter_entity_rows: vec![],
            parameter_contains_rows: vec![],
            external_entity_rows: vec![],
            external_contains_rows: vec![],
            typeflow_oracle_hits: vec![],
            typeflow_pending_call_shapes: vec![],
            pending_sites: vec![SemanticSite {
                start_utf16: 0,
                end_utf16: 5,
                site_kind: SiteKind::Call,
                disposition: SiteDisposition::CheckerPending,
                reason: Some("call_deferred_to_e3".into()),
            }],
            sites_digest: "jsts:sites:sha256:nonempty".into(),
            jsdoc_typed_file: false,
            ambient_global_dependencies: vec![],
        };
        assert!(!hybrid_owner_can_skip_checker(&semantics, false, false));
    }

    #[test]
    fn hybrid_owner_cannot_skip_checker_when_stage_three_is_required_even_with_no_pending_sites() {
        // E1a's actual policy: `TypedDecl` sites are unconditionally pending,
        // so `pending_sites` alone never fully clears yet -- but the
        // predicate must still respect an explicit stage-3 requirement on
        // its own, independent of what happened to be observed pending.
        let semantics = OwnerSemantics {
            reference_rows: vec![],
            covers_rows: vec![],
            call_rows: vec![],
            heritage_rows: vec![],
            typeflow_call_rows: vec![],
            typeflow_heritage_rows: vec![],
            pending_site_rows: vec![],
            candidate_call_rows: vec![],
            parameter_entity_rows: vec![],
            parameter_contains_rows: vec![],
            external_entity_rows: vec![],
            external_contains_rows: vec![],
            typeflow_oracle_hits: vec![],
            typeflow_pending_call_shapes: vec![],
            pending_sites: vec![],
            sites_digest: "jsts:sites:sha256:empty".into(),
            jsdoc_typed_file: false,
            ambient_global_dependencies: vec![],
        };
        assert!(!hybrid_owner_can_skip_checker(&semantics, true, false));
    }

    #[test]
    fn hybrid_owner_can_skip_checker_when_the_checker_lane_is_globally_disabled() {
        // P1-B: the checker-off pipeline mode (`URDIRA_JSTS_TYPEFLOW=1`)
        // skips EVERY owner uniformly, regardless of pending sites or a
        // stage-3 requirement -- the opposite of both other "cannot skip"
        // tests above, with `checker_lane_disabled: true` as the only
        // difference.
        let semantics = OwnerSemantics {
            reference_rows: vec![],
            covers_rows: vec![],
            call_rows: vec![],
            heritage_rows: vec![],
            typeflow_call_rows: vec![],
            typeflow_heritage_rows: vec![],
            pending_site_rows: vec![],
            candidate_call_rows: vec![],
            parameter_entity_rows: vec![],
            parameter_contains_rows: vec![],
            external_entity_rows: vec![],
            external_contains_rows: vec![],
            typeflow_oracle_hits: vec![],
            typeflow_pending_call_shapes: vec![],
            pending_sites: vec![SemanticSite {
                start_utf16: 0,
                end_utf16: 5,
                site_kind: SiteKind::Call,
                disposition: SiteDisposition::CheckerPending,
                reason: Some("call_deferred_to_e3".into()),
            }],
            sites_digest: "jsts:sites:sha256:nonempty".into(),
            jsdoc_typed_file: false,
            ambient_global_dependencies: vec![],
        };
        assert!(hybrid_owner_can_skip_checker(&semantics, true, true));
    }

    #[test]
    fn compute_hybrid_semantics_reads_the_cas_blob_and_analyzes_each_owner() {
        let source = b"function outer(value) {\n  return value;\n}\n";
        let source_path = std::env::temp_dir().join(format!(
            "urdira-indexing-worker-hybrid-owner-{}.ts",
            std::process::id()
        ));
        std::fs::write(&source_path, source).expect("write source blob");
        let mut hasher = Sha256::new();
        hasher.update(source);
        let mut digest = String::from("sha256:");
        for byte in hasher.finalize() {
            let _ = write!(&mut digest, "{byte:02x}");
        }
        let owner = SourceInput {
            path: "owner.ts".into(),
            artifact_id: "artifact:owner".into(),
            artifact_version_id: "version:owner".into(),
            content_digest: digest,
            source_blob_path: source_path.to_string_lossy().into_owned(),
            byte_length: source.len(),
        };
        let files_by_path: HashMap<&str, &SourceInput> =
            [(owner.path.as_str(), &owner)].into_iter().collect();
        let affected_paths = vec![owner.path.clone()];
        let resolver = WorkspaceResolver::default();
        let available = BTreeSet::new();
        let files = BTreeMap::new();
        let ambient_index = urdira_jsts_syntax_worker::AmbientModuleIndex::default();
        let ctx = HybridResolutionContext {
            resolver: &resolver,
            available: &available,
            files: &files,
            typeflow_index: None,
            typeflow_oracle: false,
            ambient_index: &ambient_index,
        };
        let result = compute_hybrid_semantics(&affected_paths, &files_by_path, &ctx)
            .expect("hybrid analysis");
        let semantics = result
            .get("owner.ts")
            .expect("owner present in the result map");
        assert!(
            !semantics.reference_rows.is_empty(),
            "the parameter is referenced twice inside `outer` and both should resolve"
        );
        let _ = std::fs::remove_file(&source_path);
    }

    #[test]
    fn compute_hybrid_semantics_rejects_a_content_digest_mismatch() {
        let source_path = std::env::temp_dir().join(format!(
            "urdira-indexing-worker-hybrid-mismatch-{}.ts",
            std::process::id()
        ));
        std::fs::write(&source_path, b"const a = 1;\n").expect("write source blob");
        let owner = SourceInput {
            path: "owner.ts".into(),
            artifact_id: "artifact:owner".into(),
            artifact_version_id: "version:owner".into(),
            content_digest:
                "sha256:0000000000000000000000000000000000000000000000000000000000000000".into(),
            source_blob_path: source_path.to_string_lossy().into_owned(),
            byte_length: 13,
        };
        let files_by_path: HashMap<&str, &SourceInput> =
            [(owner.path.as_str(), &owner)].into_iter().collect();
        let affected_paths = vec![owner.path.clone()];
        let resolver = WorkspaceResolver::default();
        let available = BTreeSet::new();
        let files = BTreeMap::new();
        let ambient_index = urdira_jsts_syntax_worker::AmbientModuleIndex::default();
        let ctx = HybridResolutionContext {
            resolver: &resolver,
            available: &available,
            files: &files,
            typeflow_index: None,
            typeflow_oracle: false,
            ambient_index: &ambient_index,
        };
        let error = compute_hybrid_semantics(&affected_paths, &files_by_path, &ctx)
            .expect_err("a digest mismatch must fail closed instead of analyzing stale bytes");
        assert!(error.0.contains("digest mismatch"), "error: {}", error.0);
        let _ = std::fs::remove_file(&source_path);
    }

    /// P1-C: found live -- `TypeflowCensus::identifier_calls` was added
    /// alongside `calls`/`heritage` but `write_typeflow_census`'s own
    /// read-merge-write forgot to list it, so every generation's own
    /// in-memory count was silently discarded on write and the on-disk
    /// census always read back zero. Two writes to the SAME path (mirrors
    /// a cold generation followed by a mutation generation, the exact
    /// shape that surfaced this live) must accumulate `identifier_calls`
    /// the same way `calls`/`heritage` already do.
    #[test]
    fn write_typeflow_census_accumulates_identifier_calls_across_writes() {
        let dir = std::env::temp_dir().join(format!(
            "urdira-typeflow-census-test-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        let path = dir.join("census.json");
        let _ = std::fs::remove_file(&path);
        let mut first = TypeflowCensus::default();
        first.identifier_calls.attempted_sites = 3;
        first.identifier_calls.both_confirmed_same_target = 2;
        write_typeflow_census(&path, &first).expect("first write succeeds");
        let mut second = TypeflowCensus::default();
        second.identifier_calls.attempted_sites = 5;
        second.identifier_calls.both_confirmed_same_target = 1;
        write_typeflow_census(&path, &second).expect("second write succeeds");
        let combined: TypeflowCensus =
            serde_json::from_slice(&std::fs::read(&path).expect("read back census file"))
                .expect("parse combined census");
        assert_eq!(combined.identifier_calls.attempted_sites, 8);
        assert_eq!(combined.identifier_calls.both_confirmed_same_target, 3);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
