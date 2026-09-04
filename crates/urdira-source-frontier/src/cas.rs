//! Content-addressed store, matching the on-disk layout
//! `packages/storage/src/cas.ts` and `crates/urdira-indexing-worker`'s own
//! `cas_blob_path` (`main.rs:~2541`) already read: `<cas_root>/sha256/<2 hex
//! shard>/<62 hex rest>`, one flat file per blob, stamped with a `.layout`
//! marker (`packages/storage/src/cas.ts`'s `CAS_LAYOUT_VERSION = "2"`).

use std::collections::{HashSet, VecDeque};
use std::fs::{self, File};
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::JoinHandle;

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

struct QueueState {
    items: VecDeque<(String, Vec<u8>)>,
    /// Dedupes by content hash at submission time (item 2: "dedupe by
    /// hash") -- a corpus with many byte-identical files (license
    /// headers, generated boilerplate, ...) would otherwise queue and
    /// re-write the same bytes once per occurrence. `put_if_absent`'s own
    /// `target.is_file()` check already dedupes AFTER a write lands, but
    /// checking here avoids ever cloning/queueing the duplicate bytes in
    /// the first place.
    seen: HashSet<String>,
    closed: bool,
    error: Option<CasError>,
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
            closed: false,
            error: None,
        }));
        let not_empty = Arc::new(Condvar::new());
        let not_full = Arc::new(Condvar::new());
        let worker_count = worker_count.max(1);
        let mut workers = Vec::with_capacity(worker_count);
        for _ in 0..worker_count {
            let store = Arc::clone(&store);
            let state = Arc::clone(&state);
            let not_empty = Arc::clone(&not_empty);
            let not_full = Arc::clone(&not_full);
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
                    if let Err(error) = store.put_if_absent(&bytes, &content_hash) {
                        let mut guard = state.lock().unwrap_or_else(|poison| poison.into_inner());
                        if guard.error.is_none() {
                            guard.error = Some(error);
                        }
                    }
                }
            }));
        }
        Self {
            store,
            state,
            not_empty,
            not_full,
            capacity: capacity.max(1),
            workers,
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
}
