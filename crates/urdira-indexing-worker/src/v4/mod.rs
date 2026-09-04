//! v4 cold-scan pipeline (plan `resilient-knitting-twilight.md` §4, task
//! P2-2b): catalog -> parse/semantics -> facts materialised directly into
//! `urdira-structural-store` rows -> segment write -> Merkle -> SQLite
//! snapshot -> `Queryable`/`ScanCompleted` events, behind the
//! `IndexingCommand::WorkspaceScan` protocol command. No TypeScript checker,
//! no TEMP-SQLite staging: this is a from-scratch re-plumb of the facts
//! path, not a refactor of `main.rs`'s v3 pipeline (see this module's
//! sibling files' doc comments for exactly which v3 recipes are
//! reproduced and where).
//!
//! Every file in this directory is new. `main.rs` is touched only to
//! declare `mod v4;` and add the `IndexingCommand::WorkspaceScan` dispatch
//! arm -- a concurrent typeflow effort owns `main.rs`'s existing v3 facts
//! lane in a separate worktree, so nothing in this module calls into it.

pub mod analyze;
pub mod catalog;
pub mod delta;
pub mod deps;
pub mod diff;
pub mod materialize;
pub mod publish;
pub mod residual;
pub mod scan;
pub mod state;
#[cfg(test)]
mod tests_e2e;
pub mod timings;
pub mod typeflow;

/// Shared error type for this module. Deliberately a plain string (like
/// `urdira_indexing_core::CoreError`, which this module does not reuse
/// because it carries v3 candidate-lifecycle semantics this pipeline has no
/// use for) rather than a `Box<dyn Error>` chain: every call site here
/// already has a specific, human-readable message to attach by the time an
/// operation fails, and the only consumer (`scan::run`'s caller in
/// `main.rs`) turns this straight into `IndexingEvent::Error.message`.
#[derive(Debug, Clone)]
pub struct ScanError(pub String);

impl std::fmt::Display for ScanError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for ScanError {}

impl From<String> for ScanError {
    fn from(value: String) -> Self {
        Self(value)
    }
}

impl From<&str> for ScanError {
    fn from(value: &str) -> Self {
        Self(value.to_string())
    }
}

impl From<std::io::Error> for ScanError {
    fn from(value: std::io::Error) -> Self {
        Self(format!("v4 scan I/O error: {value}"))
    }
}

impl From<rusqlite::Error> for ScanError {
    fn from(value: rusqlite::Error) -> Self {
        Self(format!("v4 scan SQL error: {value}"))
    }
}

impl From<urdira_indexing_core::CoreError> for ScanError {
    fn from(value: urdira_indexing_core::CoreError) -> Self {
        Self(format!("v4 scan core error: {}", value.0))
    }
}

impl From<urdira_structural_store::error::StoreError> for ScanError {
    fn from(value: urdira_structural_store::error::StoreError) -> Self {
        Self(format!("v4 structural store error: {value}"))
    }
}

/// UTC `YYYY-MM-DDTHH:MM:SS.sssZ` for the several `TEXT` timestamp columns
/// this pipeline writes (`source_observation_batches.started_at`/
/// `completed_at`, `snapshots.published_at`, ...). v3 gets these strings
/// from the TS candidate-publication envelope (`new Date().toISOString()`);
/// a v4 cold scan has no such envelope, so this is a minimal from-scratch
/// civil-calendar formatter (no `chrono`/`time` dependency in this crate) --
/// Howard Hinnant's `days_from_civil`/`civil_from_days` algorithm, the same
/// one `date`/`libc++`/most timestamp crates use internally.
pub fn now_iso8601() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let total_ms = now.as_millis();
    let secs = (total_ms / 1000) as i64;
    let millis = (total_ms % 1000) as u32;
    let days = secs.div_euclid(86_400);
    let sod = secs.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    let hour = sod / 3600;
    let minute = (sod % 3600) / 60;
    let second = sod % 60;
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{millis:03}Z")
}

/// Howard Hinnant's `civil_from_days`: days since the Unix epoch -> (year,
/// month, day). <https://howardhinnant.github.io/date_algorithms.html>
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32; // [1, 12]
    let y = if m <= 2 { y + 1 } else { y };
    (y, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn civil_from_days_matches_known_dates() {
        // 1970-01-01 is day 0.
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        // 2026-09-02 (today, per this task's date) is day 20698.
        assert_eq!(civil_from_days(20_698), (2026, 9, 2));
        // 2000-03-01 (a leap-year boundary case) is day 11017.
        assert_eq!(civil_from_days(11_017), (2000, 3, 1));
    }

    #[test]
    fn now_iso8601_has_the_expected_shape() {
        let value = now_iso8601();
        assert_eq!(value.len(), 24, "{value}");
        assert_eq!(&value[4..5], "-");
        assert_eq!(&value[7..8], "-");
        assert_eq!(&value[10..11], "T");
        assert_eq!(&value[13..14], ":");
        assert_eq!(&value[16..17], ":");
        assert_eq!(&value[19..20], ".");
        assert!(value.ends_with('Z'));
    }
}
