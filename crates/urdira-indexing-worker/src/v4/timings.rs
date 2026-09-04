//! Per-phase wall-clock timing for one `WorkspaceScan` (plan
//! `resilient-knitting-twilight.md` §4/§10 gate vocabulary). A single
//! `Instant` is kept and each phase records its own elapsed delta at the
//! moment it finishes, so phases that run concurrently (e.g. materialise
//! overlapping with the writer, per plan §2.4) still get an honest total
//! (`finish` uses the timer's own elapsed time, not a sum of the phases).

use std::time::{Duration, Instant};
use urdira_worker_protocol::ScanTimings;

/// P2-2h item 5: peak-RSS-so-far probe for `URDIRA_DEBUG_TIMING`-gated
/// phase-boundary reports. This crate's every module is `#![forbid(unsafe_
/// code)]` (`main.rs`), which rules out a direct `getrusage(2)` FFI call
/// (the task's suggested mechanism) -- so this shells out to the system
/// `ps` (`-o rss=`, current RSS in KiB, POSIX-portable to both macOS and
/// Linux) instead, entirely through safe `std::process::Command`, and
/// keeps a process-wide running maximum across every call
/// (`PEAK_RSS_KIB_SO_FAR`) to reproduce `getrusage`'s own "monotonic peak,
/// not a point-in-time snapshot" semantics -- calling this at successive
/// phase boundaries still reports "the highest RSS observed by ANY call so
/// far", letting a debug report localize which phase's own allocation
/// volume pushed the peak higher. Returns the best answer it can get: an
/// unparseable/failed `ps` invocation leaves the running maximum
/// unchanged and reports it as-is (`0.0` before the first successful
/// call), rather than erroring a scan over a measurement-only probe.
pub fn peak_rss_mib() -> f64 {
    static PEAK_RSS_KIB_SO_FAR: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    use std::sync::atomic::Ordering;
    if let Some(current_kib) = current_rss_kib() {
        PEAK_RSS_KIB_SO_FAR.fetch_max(current_kib, Ordering::Relaxed);
    }
    PEAK_RSS_KIB_SO_FAR.load(Ordering::Relaxed) as f64 / 1024.0
}

fn current_rss_kib() -> Option<u64> {
    let pid = std::process::id();
    let output = std::process::Command::new("ps")
        .args(["-o", "rss=", "-p", &pid.to_string()])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    std::str::from_utf8(&output.stdout)
        .ok()?
        .trim()
        .parse::<u64>()
        .ok()
}

#[derive(Debug, Clone, Copy, Default)]
pub struct PhaseTimings {
    pub catalog_ms: Option<u64>,
    pub parse_ms: Option<u64>,
    pub resolve_ms: Option<u64>,
    pub materialize_ms: Option<u64>,
    pub write_ms: Option<u64>,
    pub fsync_ms: Option<u64>,
    pub snapshot_ms: Option<u64>,
    pub lexical_ms: Option<u64>,
}

pub struct ScanClock {
    started: Instant,
    phases: PhaseTimings,
}

fn as_ms(duration: Duration) -> u64 {
    u64::try_from(duration.as_millis()).unwrap_or(u64::MAX)
}

impl ScanClock {
    pub fn start() -> Self {
        Self {
            started: Instant::now(),
            phases: PhaseTimings::default(),
        }
    }

    pub fn elapsed(&self) -> Duration {
        self.started.elapsed()
    }

    pub fn record_catalog(&mut self, duration: Duration) {
        self.phases.catalog_ms = Some(as_ms(duration));
    }
    pub fn record_parse(&mut self, duration: Duration) {
        self.phases.parse_ms = Some(as_ms(duration));
    }
    pub fn record_resolve(&mut self, duration: Duration) {
        self.phases.resolve_ms = Some(as_ms(duration));
    }
    pub fn record_materialize(&mut self, duration: Duration) {
        self.phases.materialize_ms = Some(as_ms(duration));
    }
    pub fn record_write(&mut self, duration: Duration) {
        self.phases.write_ms = Some(as_ms(duration));
    }
    pub fn record_fsync(&mut self, duration: Duration) {
        self.phases.fsync_ms = Some(as_ms(duration));
    }
    pub fn record_snapshot(&mut self, duration: Duration) {
        self.phases.snapshot_ms = Some(as_ms(duration));
    }

    /// Snapshot at the `Queryable` milestone: catalog/parse/resolve/
    /// materialize/write are known by then, fsync/snapshot are not (they
    /// happen after, plan §2.4 step 3).
    pub fn queryable_timings(&self) -> ScanTimings {
        ScanTimings {
            catalog_ms: self.phases.catalog_ms,
            parse_ms: self.phases.parse_ms,
            resolve_ms: self.phases.resolve_ms,
            materialize_ms: self.phases.materialize_ms,
            write_ms: self.phases.write_ms,
            fsync_ms: None,
            snapshot_ms: None,
            lexical_ms: self.phases.lexical_ms,
            total_ms: as_ms(self.elapsed()),
        }
    }

    /// Final snapshot at `ScanCompleted`, once every phase has run.
    pub fn completed_timings(&self) -> ScanTimings {
        ScanTimings {
            catalog_ms: self.phases.catalog_ms,
            parse_ms: self.phases.parse_ms,
            resolve_ms: self.phases.resolve_ms,
            materialize_ms: self.phases.materialize_ms,
            write_ms: self.phases.write_ms,
            fsync_ms: self.phases.fsync_ms,
            snapshot_ms: self.phases.snapshot_ms,
            lexical_ms: self.phases.lexical_ms,
            total_ms: as_ms(self.elapsed()),
        }
    }
}
