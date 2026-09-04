//! Reader refcount protocol (plan §2.3): each open [`crate::reader::StoreReader`]
//! drops a marker file under `structural/.readers/<pid>-<nonce>-<time>`
//! naming the segment directories it has mapped; [`compact`] (and any
//! future background compactor) consults [`segments_in_use`] before
//! deleting a superseded generation's directories, and skips one still
//! named by a live process's marker. Markers left by dead processes
//! (`kill -0 <pid>` fails) are treated as stale and removed.
//!
//! [`compact`]: crate::compact::compact

use crate::error::Result;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

#[derive(Serialize, Deserialize)]
struct ReaderMarker {
    segments: Vec<String>,
}

/// Held by a loaded store snapshot; removes its marker file on drop
/// (i.e. when the last `Arc` to that snapshot goes away).
pub(crate) struct ReaderGuard {
    path: PathBuf,
}

impl Drop for ReaderGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

static NONCE: AtomicU64 = AtomicU64::new(0);

pub(crate) fn register(dir: &Path, segments: &[String]) -> Result<ReaderGuard> {
    let readers_dir = dir.join(".readers");
    std::fs::create_dir_all(&readers_dir)?;
    let nonce = NONCE.fetch_add(1, Ordering::Relaxed);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let name = format!("{}-{nonce}-{nanos}", std::process::id());
    let path = readers_dir.join(name);
    let marker = ReaderMarker {
        segments: segments.to_vec(),
    };
    std::fs::write(&path, serde_json::to_vec(&marker)?)?;
    Ok(ReaderGuard { path })
}

/// Shells out to `kill -0 <pid>` rather than calling `libc::kill`
/// directly: this crate keeps `unsafe` limited to what `memmap2`
/// requires, and liveness checks only happen during the (rare,
/// background) compaction path, so a process spawn's cost is a
/// non-issue.
fn process_alive(pid: u32) -> bool {
    std::process::Command::new("kill")
        .args(["-0", &pid.to_string()])
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// The set of segment directory names (e.g. `"base-3"`, `"delta-7"`)
/// named by a live process's reader marker.
pub fn segments_in_use(dir: &Path) -> Result<HashSet<String>> {
    let readers_dir = dir.join(".readers");
    let mut in_use = HashSet::new();
    let entries = match std::fs::read_dir(&readers_dir) {
        Ok(e) => e,
        Err(_) => return Ok(in_use),
    };
    for entry in entries {
        let entry = entry?;
        let path = entry.path();
        let file_name = entry.file_name();
        let file_name = file_name.to_string_lossy();
        let pid: u32 = match file_name.split('-').next().and_then(|s| s.parse().ok()) {
            Some(p) => p,
            None => continue,
        };
        if !process_alive(pid) {
            let _ = std::fs::remove_file(&path);
            continue;
        }
        if let Ok(bytes) = std::fs::read(&path)
            && let Ok(marker) = serde_json::from_slice::<ReaderMarker>(&bytes)
        {
            in_use.extend(marker.segments);
        }
    }
    Ok(in_use)
}
