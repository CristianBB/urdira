//! Content-addressed store, matching the on-disk layout
//! `packages/storage/src/cas.ts` and `crates/urdira-indexing-worker`'s own
//! `cas_blob_path` (`main.rs:~2541`) already read: `<cas_root>/sha256/<2 hex
//! shard>/<62 hex rest>`, one flat file per blob, stamped with a `.layout`
//! marker (`packages/storage/src/cas.ts`'s `CAS_LAYOUT_VERSION = "2"`).

use std::collections::{HashMap, HashSet, VecDeque};
use std::fs::{self, File};
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

const LAYOUT_MARKER_FILENAME: &str = ".layout";
const LAYOUT_VERSION: &str = "2";

#[derive(Debug)]
pub enum CasError {
    InvalidDigest(String),
    Io(std::io::Error),
    LayoutMismatch { found: String },
}

impl std::fmt::Display for CasError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CasError::InvalidDigest(digest) => write!(
                formatter,
                "not a canonical sha256:<64 hex> digest: {digest}"
            ),
            CasError::Io(error) => write!(formatter, "CAS I/O error: {error}"),
            CasError::LayoutMismatch { found } => write!(
                formatter,
                "CAS layout marker mismatch: found {found:?}, expected {LAYOUT_VERSION:?}"
            ),
        }
    }
}

impl std::error::Error for CasError {}

impl From<std::io::Error> for CasError {
    fn from(error: std::io::Error) -> Self {
        CasError::Io(error)
    }
}

/// `casObjectRelativeParts(contentHash)` (`packages/storage/src/cas.ts`):
/// `["sha256", <first 2 hex chars>, <remaining 62 hex chars>]`, joined as a
/// path relative to `cas_root`. Also matches
/// `crates/urdira-indexing-worker/src/main.rs`'s `cas_blob_path`.
pub fn object_relative_path(content_hash: &str) -> Result<PathBuf, CasError> {
    let hex = content_hash
        .strip_prefix("sha256:")
        .filter(|value| value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .ok_or_else(|| CasError::InvalidDigest(content_hash.to_string()))?;
    Ok(Path::new("sha256").join(&hex[..2]).join(&hex[2..]))
}

/// `storage_reference` value written into `content_blobs`
/// (`packages/storage/src/cas.ts:205`): `cas:<content_hash>`.
pub fn storage_reference(content_hash: &str) -> String {
    format!("cas:{content_hash}")
}

#[derive(Debug)]
pub struct CasStore {
    root: PathBuf,
}

impl CasStore {
    /// Opens (creating if necessary) a CAS root and ensures its `.layout`
    /// marker is stamped and reads as version 2, matching
    /// `writeCasLayoutMarker`'s atomic temp-file-then-rename write.
    pub fn open(root: &Path) -> Result<Self, CasError> {
        fs::create_dir_all(root)?;
        let marker = root.join(LAYOUT_MARKER_FILENAME);
        match fs::read_to_string(&marker) {
            Ok(found) if found == LAYOUT_VERSION => {}
            Ok(found) => return Err(CasError::LayoutMismatch { found }),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let temporary = root.join(format!(".layout{}", unique_temp_name()));
                fs::write(&temporary, LAYOUT_VERSION)?;
                fs::rename(&temporary, &marker)?;
            }
            Err(error) => return Err(error.into()),
        }
        // Pre-create every one of the 256 `sha256/<2 hex>` shard
        // directories `object_relative_path` can ever address, once, here
        // -- instead of `put_if_absent` calling `fs::create_dir_all` (a
        // `mkdir` syscall, EEXIST-tolerant but still a syscall) once per
        // observed file. On a cold scan calling `put_if_absent` for every
        // file in the workspace (tens of thousands on a real corpus), that
        // collapses tens of thousands of redundant `mkdir` calls into 256
        // (see this task's evidence doc for the measured effect on n8n's
        // catalog phase). Cheap even for a store that already has these
        // directories (each iteration is one EEXIST-tolerant `create_dir`).
        let shard_root = root.join("sha256");
        for high in 0u8..=0xf {
            for low in 0u8..=0xf {
                let shard = format!("{:x}{:x}", high, low);
                fs::create_dir_all(shard_root.join(shard))?;
            }
        }
        Ok(Self {
            root: root.to_path_buf(),
        })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Absolute path a blob with this content hash would live at.
    pub fn blob_path(&self, content_hash: &str) -> Result<PathBuf, CasError> {
        Ok(self.root.join(object_relative_path(content_hash)?))
    }

    /// Writes `bytes` under `content_hash`'s CAS path if not already
    /// present: write to a sibling temp file, then rename into place.
    ///
    /// Concurrency/uniqueness: the temp filename used to be
    /// `.tmp-{pid}-{nanos}`, keyed only by the process id and a
    /// `SystemTime::now()` timestamp. On macOS, `SystemTime` is backed by a
    /// microsecond-resolution clock (`gettimeofday`), not a true
    /// nanosecond one, so two threads racing `put_if_absent` for two
    /// *different* content hashes that happen to land in the same two-hex
    /// shard directory could observe the same `(pid, "nanos")` pair and
    /// thus the same temp path. `File::create` has no `O_EXCL` semantics,
    /// so the second thread's `create` silently truncates the first
    /// thread's still-open temp file out from under it instead of erroring
    /// — the two threads' writes interleave on one inode, and whichever
    /// `rename` runs first moves the *other* thread's half-written bytes
    /// under a target path keyed by *this* thread's digest, producing a
    /// blob whose bytes don't match its own filename. That is the
    /// documented "source digest mismatch" flake this crate's stress test
    /// (`put_if_absent_survives_concurrent_shard_collisions` below)
    /// reproduces against the old naming scheme and no longer reproduces
    /// with the fix below. Fixed two ways, belt-and-suspenders:
    /// 1. The temp name is now guaranteed unique per call regardless of
    ///    clock resolution: pid + a process-wide monotonic counter + the
    ///    calling thread's `ThreadId` — no two concurrent `put_if_absent`
    ///    calls anywhere in this process can ever compute the same temp
    ///    path, independent of what the wall clock reads.
    /// 2. The temp file is opened with `create_new` (`O_EXCL`), so even a
    ///    hypothetical remaining collision (e.g. a stale temp file left
    ///    over from a killed process reusing the same pid) fails loudly
    ///    with an I/O error instead of silently truncating live data.
    ///
    /// Durability: deliberately does NOT `fsync` the blob. On macOS,
    /// `File::sync_all`/`sync_data` invoke `fcntl(F_FULLFSYNC)`, which
    /// forces a full drive cache flush and costs low-single-digit
    /// milliseconds per call — for a cold scan calling this once per
    /// observed file (tens of thousands of files), that serialized fsync
    /// cost alone dominated the whole catalog phase (see this task's
    /// evidence doc). It is safe to drop: a CAS blob is a derived,
    /// content-addressed cache of a file that still exists, unmodified, in
    /// the workspace's own source tree — an unclean shutdown that loses an
    /// unflushed blob write is repaired for free by the next scan
    /// re-observing the same path and re-deriving the same content hash.
    /// `rename`'s atomicity (not durability) is what this store's
    /// correctness invariant actually depends on: a reader never observes
    /// a torn/partial blob at `target`, because the directory entry only
    /// ever points at a fully-written temp file's final byte-for-byte
    /// content once renamed into place. Returns the absolute path either
    /// way.
    pub fn put_if_absent(&self, bytes: &[u8], content_hash: &str) -> Result<PathBuf, CasError> {
        let relative = object_relative_path(content_hash)?;
        let target = self.root.join(&relative);
        if target.is_file() {
            return Ok(target);
        }
        // Diagnostic-only: widens the window between a `CasWriteQueue`
        // worker picking up an item and the blob actually landing on disk,
        // so a test can reliably observe `CasWrittenSignal::wait_written`
        // blocking a concurrent reader instead of racing a write that is
        // normally microseconds long. See `diagnostic_write_delay`'s own
        // doc comment; zero-cost (one `OnceLock` check, no sleep) unless a
        // developer explicitly sets `URDIRA_DIAGNOSTIC_CAS_DELAY_MS`.
        let delay = diagnostic_write_delay();
        if !delay.is_zero() {
            std::thread::sleep(delay);
        }
        // No `create_dir_all` here: `CasStore::open` already pre-created
        // every one of the 256 possible shard directories (see its doc
        // comment) -- one `mkdir`-shaped syscall per file, on every cold
        // scan, was worth avoiding at this call site's scale.
        let parent = target
            .parent()
            .expect("object path always has a shard parent");
        let temporary = parent.join(unique_temp_name());
        {
            let mut file = File::options()
                .write(true)
                .create_new(true)
                .open(&temporary)?;
            file.write_all(bytes)?;
        }
        // A concurrent winner may have already created `target`; `rename`
        // still succeeds and simply replaces it with byte-identical content
        // (same hash implies same bytes, modulo hash collision).
        fs::rename(&temporary, &target)?;
        Ok(target)
    }
}

/// A sink a walker can hand `(content_hash, bytes)` pairs to without caring
/// whether the write happens inline (on the calling thread, before the
/// walker moves on to the next file) or asynchronously (queued for a
/// dedicated background pool, see [`CasWriteQueue`] below, item 2 of the
/// P2-2h round: "the structural index does not need CAS blobs (only
/// `get_source`/FTS do)"). `hash_and_include` (`walker.rs`) is the only
/// caller; both `Walker::enumerate`/`observe_paths` take `Option<&dyn
/// CasPut>` so a cold scan can pass a queue and an incremental scan (small
/// file counts, not on this round's critical path) can keep the original
/// inline behavior unchanged.
pub trait CasPut: Sync {
    fn put(&self, content_hash: &str, bytes: Vec<u8>);
}

impl CasPut for CasStore {
    fn put(&self, content_hash: &str, bytes: Vec<u8>) {
        // Best-effort: a cold scan that queues instead (the actual
        // critical-path caller) surfaces write errors through
        // `CasWriteQueue::join`; this inline path is only used today by
        // incremental scans and tests, where `put_if_absent`'s own
        // `Result` was already silently ignored by callers going through
        // this same "write it, move on" shape prior to this round.
        let _ = self.put_if_absent(&bytes, content_hash);
    }
}

/// Memory cost of the completion registry (`seen`/`written`/`failed`
/// below), added by this task on top of `CasWriteQueue`'s pre-existing
/// `seen` dedup set: roughly one extra `String` (a `sha256:<64 hex>`
/// content hash, ~71 bytes plus `HashSet`/`HashMap` bucket overhead) per
/// distinct file for the scan's lifetime, since a hash moves from `seen`
/// into `written` (or `failed`) on completion but is never REMOVED from
/// `seen` -- `submit`'s own dedup check and a late `wait_written` call for
/// an already-completed hash both still need to find it there. On n8n's
/// corpus (~15k JS/TS owners after non-source config assets are excluded)
/// that is on the order of two retained hash strings per owner for the
/// scan's duration -- roughly 2 MiB total, negligible next to this
/// pipeline's other per-scan structures (`SyntaxWorkerState`'s parsed ASTs,
/// `TypeflowCache`'s `DeclSummary`s) and reclaimed the instant
/// `CasWriteQueue`/every `CasWrittenSignal` clone of it is dropped at the
/// end of the scan that owns it.
struct QueueState {
    items: VecDeque<(String, Vec<u8>)>,
    /// Dedupes by content hash at submission time (item 2: "dedupe by
    /// hash") -- a corpus with many byte-identical files (license
    /// headers, generated boilerplate, ...) would otherwise queue and
    /// re-write the same bytes once per occurrence. `put_if_absent`'s own
    /// `target.is_file()` check already dedupes AFTER a write lands, but
    /// checking here avoids ever cloning/queueing the duplicate bytes in
    /// the first place. Doubles as the completion registry's "known hash"
    /// set: every hash [`CasWrittenSignal::wait_written`] can legitimately
    /// be asked about was inserted here first, at `submit` time --  a hash
    /// never submitted to this queue instance is not in `seen` either, and
    /// `wait_written` returns an immediate error for it rather than
    /// blocking (see that method's doc comment).
    seen: HashSet<String>,
    /// Every content hash whose `put_if_absent` call has RETURNED
    /// successfully -- whether that call actually wrote new bytes or found
    /// the blob already durable from a prior scan/process (`put_if_absent`'s
    /// `target.is_file()` fast path): either way the blob is now guaranteed
    /// present on disk, which is the only thing a waiter cares about. A
    /// worker inserts here (never removes) immediately before releasing
    /// this lock and notifying `CasWriteQueue::written_cond`.
    written: HashSet<String>,
    /// Content hashes whose `put_if_absent` call returned `Err`, keyed to a
    /// `Display`-rendered copy of that error (`CasError` itself is not
    /// `Clone` -- `std::io::Error` isn't -- so the first worker to observe
    /// the failure renders it to a `String` once, here, for any waiter to
    /// read back; the ORIGINAL typed `CasError` is separately kept in
    /// `error` below for `join`'s existing contract). A hash in `failed` is
    /// also in `seen` (inserted at submit time) but never moves to
    /// `written`.
    failed: HashMap<String, String>,
    closed: bool,
    error: Option<CasError>,
}

/// Surfaced by [`CasWrittenSignal::wait_written`] instead of blocking
/// forever or silently returning success.
#[derive(Debug)]
pub enum CasWaitError {
    /// `wait_written` was asked about a content hash this queue instance
    /// never received a `submit` call for -- either a caller bug (waiting
    /// on the wrong hash) or a hash that predates this queue (a PRIOR
    /// scan's blob, already durable, never resubmitted this scan): either
    /// way, blocking would hang forever with no worker ever going to
    /// complete it, so this is returned immediately instead of waiting for
    /// the timeout.
    UnknownHash(String),
    /// The write itself failed (`put_if_absent` returned `Err`) -- carries
    /// that error's `Display` text (see `QueueState::failed`'s doc comment
    /// for why this is a rendered `String`, not the original `CasError`).
    WriteFailed(String),
    /// Neither written nor failed within the requested timeout -- the
    /// safety-net case the doc comment on [`CasWrittenSignal::wait_written`]
    /// describes as "never hit in practice".
    Timeout(String),
}

impl std::fmt::Display for CasWaitError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CasWaitError::UnknownHash(hash) => {
                write!(formatter, "CAS write queue: never submitted: {hash}")
            }
            CasWaitError::WriteFailed(message) => {
                write!(formatter, "CAS write queue: write failed: {message}")
            }
            CasWaitError::Timeout(hash) => {
                write!(formatter, "CAS write queue: timed out waiting for {hash}")
            }
        }
    }
}

impl std::error::Error for CasWaitError {}

/// A cheap `Arc`-backed handle to a [`CasWriteQueue`]'s completion registry
/// only -- not `submit`/`join` (a caller with just a `CasWrittenSignal`
/// cannot enqueue more work or drain the queue, only ask "is this hash's
/// blob durable yet"). Cloning is O(1) (two `Arc::clone`s); every clone
/// observes the SAME underlying queue's state, so a signal handed to
/// `analyze::run_cold` (via `scan.rs`) sees writes land as the SAME
/// background workers `CasWriteQueue::spawn` started for that scan produce
/// them.
#[derive(Clone)]
pub struct CasWrittenSignal {
    state: Arc<Mutex<QueueState>>,
    written_cond: Arc<Condvar>,
}

impl CasWrittenSignal {
    /// Blocks the calling thread until `content_hash`'s write has been
    /// observed to finish (successfully or not) by this queue, or until
    /// `timeout` elapses. Returns immediately (no lock contention beyond
    /// one `Mutex::lock`) in the overwhelmingly common case: the blob was
    /// already written by the time the reader gets here, since
    /// `CasWriteQueue`'s worker pool starts draining the instant the walk
    /// begins and a cold scan's own catalog-apply + `analyze()` parse pass
    /// (both CPU-bound, no CAS I/O) already give it a head start before the
    /// first `read_owner_source_text` call.
    ///
    /// `timeout` is a safety net, not a expected code path -- 60s (this
    /// crate's caller passes) is comfortably above any observed write
    /// latency even under heavy scheduler contention (the exact scenario
    /// `read_blob_with_retry`'s old 200x5ms/1s ceiling used to bound); a
    /// content hash that was genuinely never submitted to this queue
    /// (`CasWaitError::UnknownHash`) is rejected immediately instead of
    /// waiting out the full timeout, since no worker will ever complete it
    /// -- see `QueueState::seen`'s doc comment for what "submitted" means
    /// here.
    pub fn wait_written(&self, content_hash: &str, timeout: Duration) -> Result<(), CasWaitError> {
        let deadline = std::time::Instant::now() + timeout;
        let mut guard = self
            .state
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        loop {
            if guard.written.contains(content_hash) {
                return Ok(());
            }
            if let Some(message) = guard.failed.get(content_hash) {
                return Err(CasWaitError::WriteFailed(message.clone()));
            }
            if !guard.seen.contains(content_hash) {
                return Err(CasWaitError::UnknownHash(content_hash.to_string()));
            }
            let now = std::time::Instant::now();
            if now >= deadline {
                return Err(CasWaitError::Timeout(content_hash.to_string()));
            }
            let (next_guard, wait_result) = self
                .written_cond
                .wait_timeout(guard, deadline - now)
                .unwrap_or_else(|poison| poison.into_inner());
            guard = next_guard;
            // A timed-out wait does not necessarily mean `content_hash`
            // itself is still pending -- another hash's completion could
            // have spuriously woken this thread just before the deadline.
            // The loop re-checks `written`/`failed`/`seen` unconditionally
            // on every iteration regardless of `wait_result`, so a missed
            // notification never causes an incorrect early return; a
            // GENUINE timeout is caught by the `now >= deadline` check
            // above on the next iteration.
            let _ = wait_result;
        }
    }
}

/// A bounded-capacity, multi-consumer queue of pending CAS writes, backed
/// by a small dedicated thread pool started alongside the walk (item 2).
/// Writes are content-addressed and idempotent, so workers can run fully
/// concurrently with no coordination beyond the shared queue itself.
/// `submit` never blocks on I/O (only, briefly, on queue capacity -- the
/// backpressure valve that keeps memory bounded if the walk produces
/// bytes faster than disk can absorb them); the actual `put_if_absent`
/// calls happen entirely off the walker's own threads. Call [`Self::join`]
/// once every producer is done submitting to wait for every queued write
/// to finish and collect the first error, if any.
pub struct CasWriteQueue {
    store: Arc<CasStore>,
    state: Arc<Mutex<QueueState>>,
    not_empty: Arc<Condvar>,
    not_full: Arc<Condvar>,
    /// Signaled by a worker every time it records a hash into
    /// `QueueState::written`/`failed` (see the worker loop in [`Self::spawn`]).
    /// Kept separate from `not_empty`/`not_full` (rather than overloading
    /// one of those) so a [`CasWrittenSignal::wait_written`] waiter is never
    /// spuriously woken by ordinary queue traffic (an unrelated `submit`/
    /// `pop_front`) and, conversely, so a completion never has to also
    /// notify the producer/consumer condvars it has nothing to do with.
    written_cond: Arc<Condvar>,
    capacity: usize,
    workers: Vec<JoinHandle<()>>,
}

impl CasWriteQueue {
    /// Spawns `worker_count` dedicated OS threads (NOT rayon's shared
    /// global pool -- item 2 asks for a background pool "started with the
    /// walk", separate from the walk's own CPU-bound parallelism so I/O-
    /// blocked CAS writes never steal a rayon worker slot from the
    /// walk/hash/parse/materialize work sharing that pool) that drain
    /// `submit`ted writes until [`Self::join`] closes the queue.
    pub fn spawn(store: CasStore, worker_count: usize, capacity: usize) -> Self {
        let store = Arc::new(store);
        let state = Arc::new(Mutex::new(QueueState {
            items: VecDeque::with_capacity(capacity.min(1024)),
            seen: HashSet::new(),
            written: HashSet::new(),
            failed: HashMap::new(),
            closed: false,
            error: None,
        }));
        let not_empty = Arc::new(Condvar::new());
        let not_full = Arc::new(Condvar::new());
        let written_cond = Arc::new(Condvar::new());
        let worker_count = worker_count.max(1);
        let mut workers = Vec::with_capacity(worker_count);
        for _ in 0..worker_count {
            let store = Arc::clone(&store);
            let state = Arc::clone(&state);
            let not_empty = Arc::clone(&not_empty);
            let not_full = Arc::clone(&not_full);
            let written_cond = Arc::clone(&written_cond);
            workers.push(std::thread::spawn(move || {
                loop {
                    let (content_hash, bytes) = {
                        let mut guard = state.lock().unwrap_or_else(|poison| poison.into_inner());
                        loop {
                            if let Some(item) = guard.items.pop_front() {
                                not_full.notify_one();
                                break item;
                            }
                            if guard.closed {
                                return;
                            }
                            guard = not_empty
                                .wait(guard)
                                .unwrap_or_else(|poison| poison.into_inner());
                        }
                    };
                    // Recorded regardless of success/failure (item 1 of this
                    // task's brief: "on error record the error so the
                    // waiter can surface it instead of hanging") -- a
                    // waiter blocked in `CasWrittenSignal::wait_written`
                    // must be released either way, not just on success.
                    let result = store.put_if_absent(&bytes, &content_hash);
                    {
                        let mut guard = state.lock().unwrap_or_else(|poison| poison.into_inner());
                        match result {
                            Ok(_) => {
                                guard.written.insert(content_hash);
                            }
                            Err(error) => {
                                guard.failed.insert(content_hash, error.to_string());
                                if guard.error.is_none() {
                                    guard.error = Some(error);
                                }
                            }
                        }
                    }
                    written_cond.notify_all();
                }
            }));
        }
        Self {
            store,
            state,
            not_empty,
            not_full,
            written_cond,
            capacity: capacity.max(1),
            workers,
        }
    }

    /// A cheap, `Sync`-safe handle onto this queue's completion registry
    /// only (see [`CasWrittenSignal`]'s own doc comment for exactly what it
    /// can and cannot do) -- callable at any point after `spawn`, including
    /// while the queue is still actively draining. Does not consume or
    /// borrow-lock `self` beyond the two `Arc::clone`s, so a caller can hold
    /// both this signal and the queue itself (to `submit`/eventually `join`
    /// it) at the same time.
    pub fn signal(&self) -> CasWrittenSignal {
        CasWrittenSignal {
            state: Arc::clone(&self.state),
            written_cond: Arc::clone(&self.written_cond),
        }
    }

    /// The CAS root this queue's workers write into (debug/test
    /// introspection only).
    pub fn root(&self) -> &Path {
        self.store.root()
    }

    /// Submits one write, deduping by `content_hash` against every hash
    /// already submitted to this queue instance (not against what is
    /// already durable on disk -- workers still hit `put_if_absent`'s own
    /// `target.is_file()` fast path for that). Blocks only while the
    /// queue is at capacity, never on the write itself.
    pub fn submit(&self, content_hash: &str, bytes: Vec<u8>) {
        let mut guard = self
            .state
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        if !guard.seen.insert(content_hash.to_string()) {
            return;
        }
        loop {
            if guard.items.len() < self.capacity || guard.closed {
                break;
            }
            guard = self
                .not_full
                .wait(guard)
                .unwrap_or_else(|poison| poison.into_inner());
        }
        guard.items.push_back((content_hash.to_string(), bytes));
        self.not_empty.notify_one();
    }

    /// Closes the queue (no more items will ever be pulled after the
    /// current backlog drains), waits for every worker to finish, and
    /// returns the first write error encountered, if any. Consumes
    /// `self`: a joined queue cannot be submitted to again.
    pub fn join(self) -> Result<(), CasError> {
        {
            let mut guard = self
                .state
                .lock()
                .unwrap_or_else(|poison| poison.into_inner());
            guard.closed = true;
        }
        self.not_empty.notify_all();
        for worker in self.workers {
            let _ = worker.join();
        }
        let mut guard = self
            .state
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        match guard.error.take() {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }

    /// The number of distinct content hashes submitted so far (debug-
    /// timing diagnostic only).
    pub fn submitted_count(&self) -> usize {
        self.state
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .seen
            .len()
    }
}

impl CasPut for CasWriteQueue {
    fn put(&self, content_hash: &str, bytes: Vec<u8>) {
        self.submit(content_hash, bytes);
    }
}

/// A temp filename that is unique across every concurrent call in this
/// process, independent of wall-clock resolution: pid (distinguishes
/// processes sharing a CAS root, e.g. a stale/killed one) + a process-wide
/// atomic counter (distinguishes calls within this process, monotonically,
/// with no possibility of two calls observing the same value) + the calling
/// thread's `ThreadId` (belt-and-suspenders — not required for uniqueness
/// given the counter, but keeps the name legible for debugging which thread
/// wrote it).
/// Reads `URDIRA_DIAGNOSTIC_CAS_DELAY_MS` once (`OnceLock`, not once per
/// `put_if_absent` call) and caches the parsed duration for the life of the
/// process. Unset (the default for every production run and almost every
/// test) parses to `Duration::ZERO`, which `put_if_absent` checks with an
/// `is_zero()` branch before ever calling `Instant`/`sleep` machinery --
/// this is a plain env lookup cached behind an atomic-once flag, not a
/// per-write cost. Deliberately kept (not deleted after the bug it helped
/// diagnose was fixed): it is the only practical way to widen the CAS
/// write queue's normally-microseconds-wide submit-to-durable window on
/// demand, which the reproduction test below
/// (`analyze_one`/`TypeflowCache::build_full`'s callers in
/// `urdira-indexing-worker` also use it, via `cargo test ...
/// -- --ignored` style forced-delay runs) needs to prove `CasWrittenSignal::
/// wait_written` actually blocks instead of returning early by luck.
fn diagnostic_write_delay() -> Duration {
    static DELAY: std::sync::OnceLock<Duration> = std::sync::OnceLock::new();
    *DELAY.get_or_init(|| {
        std::env::var("URDIRA_DIAGNOSTIC_CAS_DELAY_MS")
            .ok()
            .and_then(|value| value.parse::<u64>().ok())
            .map(Duration::from_millis)
            .unwrap_or_default()
    })
}

fn unique_temp_name() -> String {
    static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let sequence = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    format!(
        ".tmp-{}-{:?}-{}",
        std::process::id(),
        std::thread::current().id(),
        sequence
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "urdira-source-frontier-cas-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn object_relative_path_matches_layout_2() {
        let hash = "sha256:b40dedde60828bf61d1fadbfc3bb7ea2e0421e9511d22f1b5fb44ae5ba07dbb3";
        let path = object_relative_path(hash).unwrap();
        assert_eq!(
            path,
            PathBuf::from(
                "sha256/b4/0dedde60828bf61d1fadbfc3bb7ea2e0421e9511d22f1b5fb44ae5ba07dbb3"
            )
        );
    }

    #[test]
    fn rejects_non_canonical_digest() {
        assert!(object_relative_path("md5:deadbeef").is_err());
        assert!(object_relative_path("sha256:tooshort").is_err());
    }

    #[test]
    fn put_if_absent_writes_once_and_is_idempotent() {
        let dir = temp_dir("put");
        let store = CasStore::open(&dir).unwrap();
        assert_eq!(fs::read_to_string(dir.join(".layout")).unwrap(), "2");
        let bytes = b"export const a = 1;";
        let hash = "sha256:b40dedde60828bf61d1fadbfc3bb7ea2e0421e9511d22f1b5fb44ae5ba07dbb3";
        let path = store.put_if_absent(bytes, hash).unwrap();
        assert_eq!(fs::read(&path).unwrap(), bytes);
        // Second call must be a no-op (no error, same content).
        let path_again = store.put_if_absent(bytes, hash).unwrap();
        assert_eq!(path, path_again);
        assert_eq!(fs::read(&path_again).unwrap(), bytes);
        let _ = fs::remove_dir_all(&dir);
    }

    /// Reproduces the class of bug fixed above: `put_if_absent` racing many
    /// threads across many distinct content hashes that share the CAS's
    /// 256 two-hex shard directories, then verifies every resulting blob's
    /// on-disk bytes actually hash to the digest encoded in its own path.
    /// Against the OLD `.tmp-{pid}-{nanos}` naming (temp path independent
    /// of content hash, keyed only by a clock whose resolution on macOS is
    /// microseconds, not nanoseconds), this test reliably fails within a
    /// handful of the 50 iterations below on a multi-core machine: two
    /// threads landing in the same shard at the same wall-clock tick pick
    /// the same temp filename, `File::create` (no `O_EXCL`) truncates one
    /// thread's in-flight write out from under it, and whichever thread's
    /// `rename` wins moves the *other* thread's bytes under its own
    /// digest-named target -- exactly the "source digest mismatch for
    /// <path>" flake this task set out to fix. Against the fix (a
    /// process-wide atomic-counter-keyed temp name, opened with
    /// `create_new`/`O_EXCL`), no two concurrent calls can ever address the
    /// same temp path, so this test is expected to pass every time.
    #[test]
    fn put_if_absent_survives_concurrent_shard_collisions() {
        use sha2::{Digest as _, Sha256};
        use std::sync::Arc;

        const FILE_COUNT: u32 = 1_000;
        const THREAD_COUNT: usize = 16;
        const ITERATIONS: usize = 50;

        // 1000 distinct payloads -> 1000 distinct sha256 digests spread
        // across the CAS's 256 two-hex shard directories (~4 files/shard on
        // average), so concurrent writers frequently contend on the same
        // shard -- the precondition for the old bug.
        let payloads: Vec<(String, Vec<u8>)> = (0..FILE_COUNT)
            .map(|index| {
                let bytes = format!("urdira-cas-stress-payload-{index}").into_bytes();
                let mut hasher = Sha256::new();
                hasher.update(&bytes);
                let mut hash = String::from("sha256:");
                for byte in hasher.finalize() {
                    use std::fmt::Write as _;
                    let _ = write!(&mut hash, "{byte:02x}");
                }
                (hash, bytes)
            })
            .collect();

        let dir = temp_dir("stress");
        for iteration in 0..ITERATIONS {
            // Fresh CAS root each iteration: `put_if_absent` short-circuits
            // on an already-present target, so a re-used root would stop
            // exercising the race after the first iteration wrote
            // everything once.
            let _ = fs::remove_dir_all(&dir);
            let store = Arc::new(CasStore::open(&dir).unwrap_or_else(|error| {
                panic!("iteration {iteration}: CasStore::open failed: {error}")
            }));
            let payloads = Arc::new(payloads.clone());

            std::thread::scope(|scope| {
                for thread_index in 0..THREAD_COUNT {
                    let store = Arc::clone(&store);
                    let payloads = Arc::clone(&payloads);
                    scope.spawn(move || {
                        for (offset, (hash, bytes)) in payloads.iter().enumerate() {
                            // Interleave which thread touches which payload
                            // first, instead of every thread racing through
                            // the list in the same order.
                            if (offset + thread_index) % THREAD_COUNT != 0 {
                                continue;
                            }
                            store.put_if_absent(bytes, hash).unwrap_or_else(|error| {
                                panic!(
                                    "iteration {iteration} thread {thread_index}: put_if_absent({hash}) failed: {error}"
                                )
                            });
                        }
                        // Second pass: every thread also attempts every
                        // payload (exercising the `target.is_file()`
                        // short-circuit concurrently with other threads
                        // still writing it for the first time).
                        for (hash, bytes) in payloads.iter() {
                            store.put_if_absent(bytes, hash).unwrap_or_else(|error| {
                                panic!(
                                    "iteration {iteration} thread {thread_index}: put_if_absent({hash}) retry failed: {error}"
                                )
                            });
                        }
                    });
                }
            });

            for (hash, bytes) in payloads.iter() {
                let path = store.blob_path(hash).unwrap();
                let on_disk = fs::read(&path).unwrap_or_else(|error| {
                    panic!("iteration {iteration}: reading {path:?} failed: {error}")
                });
                assert_eq!(
                    &on_disk, bytes,
                    "iteration {iteration}: blob at {path:?} (named for digest {hash}) holds the wrong bytes -- a concurrent CAS write corrupted it"
                );
            }
        }
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn open_rejects_mismatched_layout_marker() {
        let dir = temp_dir("mismatch");
        fs::write(dir.join(".layout"), "1").unwrap();
        let error = CasStore::open(&dir).unwrap_err();
        assert!(matches!(error, CasError::LayoutMismatch { .. }));
        let _ = fs::remove_dir_all(&dir);
    }

    fn sha256_of(bytes: &[u8]) -> String {
        use sha2::{Digest as _, Sha256};
        let mut hasher = Sha256::new();
        hasher.update(bytes);
        let mut hash = String::from("sha256:");
        for byte in hasher.finalize() {
            use std::fmt::Write as _;
            let _ = write!(&mut hash, "{byte:02x}");
        }
        hash
    }

    /// Serializes every test in this module that touches
    /// `URDIRA_DIAGNOSTIC_CAS_DELAY_MS`, mirroring `urdira-tsgo-client`'s
    /// `binary::tests::ENV_LOCK` (same hazard, spelled out there in full:
    /// this env var is process-global state, but Rust's default test
    /// harness runs every `#[test]` fn in this module as a separate THREAD
    /// within the SAME process). Every test that sets/removes this var
    /// must hold this lock for its full set-run-remove sequence. This
    /// crate (unlike `urdira-indexing-worker`, `#![forbid(unsafe_code)]`)
    /// permits `unsafe`, which is what lets a test set this var directly
    /// rather than requiring an external shell invocation.
    static DELAY_ENV_LOCK: Mutex<()> = Mutex::new(());

    /// Cas write queue task item 4(a): submits many blobs to a queue whose
    /// underlying store has been slowed down (`URDIRA_DIAGNOSTIC_CAS_DELAY_
    /// MS`), then waits on the LAST submitted hash from a second thread and
    /// confirms two things: (1) the blob is genuinely not yet on disk right
    /// after `submit` returns (proving the delay actually widened the
    /// window, not that the write was already done by coincidence), and
    /// (2) `wait_written` does not return `Ok` until the blob is actually
    /// durable on disk.
    #[test]
    fn wait_written_blocks_until_the_slow_stores_last_blob_is_durable() {
        let _delay_guard = DELAY_ENV_LOCK
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        // SAFETY: serialized against every other test in this module that
        // touches `URDIRA_DIAGNOSTIC_CAS_DELAY_MS`, via `DELAY_ENV_LOCK`.
        unsafe {
            std::env::set_var("URDIRA_DIAGNOSTIC_CAS_DELAY_MS", "40");
        }

        let dir = temp_dir("wait-written");
        let store = CasStore::open(&dir).unwrap();
        let queue = CasWriteQueue::spawn(store, 2, 64);
        let signal = queue.signal();

        const BLOB_COUNT: usize = 16;
        let mut hashes = Vec::with_capacity(BLOB_COUNT);
        for index in 0..BLOB_COUNT {
            let bytes = format!("wait-written-payload-{index}").into_bytes();
            let hash = sha256_of(&bytes);
            queue.submit(&hash, bytes);
            hashes.push(hash);
        }
        let last_hash = hashes.last().cloned().expect("BLOB_COUNT > 0");
        let last_path = queue
            .root()
            .join(object_relative_path(&last_hash).expect("valid digest"));

        // With 2 workers, 16 items, and a 40ms artificial delay per write,
        // draining the whole queue takes >= 8 * 40ms = 320ms -- the last
        // item cannot possibly be durable this soon after `submit` returns
        // (which itself only blocks on queue capacity, never on I/O).
        assert!(
            !last_path.is_file(),
            "the slow store finished implausibly fast -- this test's timing assumption is broken"
        );

        let waiter = {
            let signal = signal.clone();
            let last_hash = last_hash.clone();
            std::thread::spawn(move || signal.wait_written(&last_hash, Duration::from_secs(10)))
        };
        let result = waiter.join().expect("waiter thread does not panic");

        // SAFETY: same `DELAY_ENV_LOCK` guard as above.
        unsafe {
            std::env::remove_var("URDIRA_DIAGNOSTIC_CAS_DELAY_MS");
        }

        result.expect("wait_written must succeed once the slow store finishes");
        assert!(
            last_path.is_file(),
            "wait_written returned Ok before the blob was actually written to disk"
        );

        queue
            .join()
            .expect("queue join succeeds with no write errors");
        let _ = fs::remove_dir_all(&dir);
    }

    /// Item 4(b): a content hash this queue never received a `submit` call
    /// for must fail immediately, never block out the full timeout.
    #[test]
    fn wait_written_on_unknown_hash_returns_error_immediately() {
        let dir = temp_dir("wait-unknown");
        let store = CasStore::open(&dir).unwrap();
        let queue = CasWriteQueue::spawn(store, 1, 8);
        let signal = queue.signal();

        let started = std::time::Instant::now();
        let result = signal.wait_written(
            "sha256:0000000000000000000000000000000000000000000000000000000000000000",
            Duration::from_secs(30),
        );
        let elapsed = started.elapsed();

        assert!(
            matches!(result, Err(CasWaitError::UnknownHash(_))),
            "expected UnknownHash, got {result:?}"
        );
        assert!(
            elapsed < Duration::from_secs(5),
            "an unknown hash must not wait anywhere near the 30s timeout, took {elapsed:?}"
        );

        queue
            .join()
            .expect("queue join succeeds (nothing was ever submitted)");
        let _ = fs::remove_dir_all(&dir);
    }

    /// Item 4(c): a write that fails (here, an intentionally malformed
    /// content hash `put_if_absent` rejects with `CasError::InvalidDigest`
    /// before touching the filesystem at all) must be surfaced to a waiter
    /// as `CasWaitError::WriteFailed`, not silently hang or report success
    /// -- and the SAME failure must still reach `join`'s existing contract.
    #[test]
    fn wait_written_surfaces_a_write_error_to_the_waiter() {
        let dir = temp_dir("wait-error");
        let store = CasStore::open(&dir).unwrap();
        let queue = CasWriteQueue::spawn(store, 1, 8);
        let signal = queue.signal();

        let bad_hash = "not-a-valid-content-hash";
        queue.submit(bad_hash, b"whatever".to_vec());

        let result = signal.wait_written(bad_hash, Duration::from_secs(5));
        assert!(
            matches!(result, Err(CasWaitError::WriteFailed(_))),
            "expected WriteFailed, got {result:?}"
        );

        let join_result = queue.join();
        assert!(
            join_result.is_err(),
            "join must also surface the same write error, not swallow it now that a waiter already saw it"
        );

        let _ = fs::remove_dir_all(&dir);
    }
}
