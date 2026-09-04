//! Crash recovery (plan §2.6).

use crate::error::Result;
use crate::manifest::Manifest;
use std::collections::HashSet;
use std::path::Path;

/// Removes `dir/name` whether it is a base segment (directory) or a
/// P3-6 delta container (single `delta-<g>.seg` file) -- dispatches on
/// what's actually on disk rather than assuming, since this function
/// serves both kinds of name.
fn remove_segment(dir: &Path, name: &str) {
    let path = dir.join(name);
    match std::fs::symlink_metadata(&path) {
        Ok(meta) if meta.is_dir() => {
            let _ = std::fs::remove_dir_all(&path);
        }
        Ok(_) => {
            let _ = std::fs::remove_file(&path);
        }
        Err(_) => {}
    }
}

/// Deletes delta/base segments not referenced by `MANIFEST` -- a base
/// segment is a directory (`base-<g>/`), a delta generation is a single
/// container file (`delta-<g>.seg`, P3-6 item 1; no pre-P3-6 `delta-<g>/`
/// directory layout survives to check for, since v4 is unreleased). If
/// `MANIFEST.next` exists and names a generation different from the
/// published `MANIFEST`, the write never finished (crashed between
/// writing segment data and the `MANIFEST.next` -> `MANIFEST` rename):
/// its generation's segments and the `.next` file are deleted, and the
/// caller is expected to rescan from `MANIFEST`'s generation. This crate
/// has no access to the full plan's SQLite `snapshots` table (the
/// durability marker §2.6 checks); the substitute rule used here is
/// generation equality with the published `MANIFEST`.
pub fn recover(dir: &Path) -> Result<()> {
    let manifest_path = dir.join("MANIFEST");
    if !manifest_path.exists() {
        // No durable generation yet -- nothing to reconcile against;
        // the caller's full rescan will overwrite whatever is here.
        return Ok(());
    }
    let manifest = Manifest::read(&manifest_path)?;
    let mut referenced: HashSet<String> = HashSet::new();
    referenced.insert(manifest.base.clone());
    referenced.extend(manifest.deltas.iter().cloned());

    if let Some(next) = Manifest::read_next(dir)? {
        if next.generation != manifest.generation {
            if !referenced.contains(&next.base) {
                remove_segment(dir, &next.base);
            }
            for d in &next.deltas {
                if !referenced.contains(d) {
                    remove_segment(dir, d);
                }
            }
        }
        // Either way, a MANIFEST.next lying around after this call is
        // stale: `publish_next` consumes it via an atomic rename, so
        // its mere presence here means the generation it names was
        // never durably published.
        let _ = std::fs::remove_file(dir.join("MANIFEST.next"));
    }

    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries {
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().to_string();
            let is_orphan_base_dir = entry.file_type()?.is_dir() && name.starts_with("base-");
            let is_orphan_delta_file = entry.file_type()?.is_file()
                && name.starts_with("delta-")
                && name.ends_with(".seg");
            if (is_orphan_base_dir || is_orphan_delta_file) && !referenced.contains(&name) {
                remove_segment(dir, &name);
            }
        }
    }
    Ok(())
}
