//! `MANIFEST` / `MANIFEST.next` (plan §2.1/§2.6): JSON, written tmp+rename
//! for atomicity, `publish_next` renames `MANIFEST.next` -> `MANIFEST`.

use crate::error::{Result, store_err};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::Path;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct ManifestFileEntry {
    pub bytes: u64,
    pub xxh3: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
pub struct Manifest {
    pub format: u32,
    pub generation: u64,
    pub snapshot_id: Option<String>,
    pub base: String,
    pub deltas: Vec<String>,
    /// `set_kind -> "sha256:<hex>"`.
    pub roots: BTreeMap<String, String>,
    pub dict_generation: u64,
    pub files: BTreeMap<String, ManifestFileEntry>,
}

impl Manifest {
    pub fn write_atomic(&self, path: &Path) -> Result<()> {
        let json = serde_json::to_vec_pretty(self)?;
        let mut tmp_name = path.file_name().unwrap().to_os_string();
        tmp_name.push(".tmp");
        let tmp_path = path.with_file_name(tmp_name);
        std::fs::write(&tmp_path, &json)?;
        #[cfg(windows)]
        let _ = std::fs::remove_file(path);
        std::fs::rename(&tmp_path, path)?;
        if let Some(parent) = path.parent() {
            fsync_dir(parent)?;
        }
        Ok(())
    }

    pub fn read(path: &Path) -> Result<Manifest> {
        let bytes =
            std::fs::read(path).map_err(|e| store_err!("read manifest {}: {e}", path.display()))?;
        let manifest: Manifest = serde_json::from_slice(&bytes)?;
        // F4 4.3: bumped 5->6 alongside `layout::HEADER_FORMAT` -- see that
        // constant's own doc comment. A format-5 MANIFEST (written before
        // the `entities.index` section existed) fails here with a clear
        // error rather than opening a store this crate's reader would then
        // find missing a mandatory section.
        if manifest.format != 6 {
            return Err(store_err!(
                "unsupported manifest format {} (want 6)",
                manifest.format
            ));
        }
        Ok(manifest)
    }

    pub fn read_next(dir: &Path) -> Result<Option<Manifest>> {
        let path = dir.join("MANIFEST.next");
        if !path.exists() {
            return Ok(None);
        }
        Ok(Some(Manifest::read(&path)?))
    }

    /// Renames `<dir>/MANIFEST.next` to `<dir>/MANIFEST`, fsyncing the
    /// directory entry afterward.
    pub fn publish_next(dir: &Path) -> Result<()> {
        let next = dir.join("MANIFEST.next");
        let published = dir.join("MANIFEST");
        #[cfg(windows)]
        let _ = std::fs::remove_file(&published);
        std::fs::rename(&next, &published)
            .map_err(|e| store_err!("publish manifest in {}: {e}", dir.display()))?;
        fsync_dir(dir)?;
        Ok(())
    }
}

pub(crate) fn fsync_dir(dir: &Path) -> Result<()> {
    #[cfg(windows)]
    {
        // Windows does not support opening a directory as a synchronizable
        // file with the standard `File::open` flags. File contents are still
        // flushed by `fsync_segment_dir`; only the directory-entry barrier is
        // unavailable on this platform.
        let _ = dir;
        return Ok(());
    }

    let f = std::fs::File::open(dir).map_err(|e| store_err!("open dir {}: {e}", dir.display()))?;
    f.sync_all()
        .map_err(|e| store_err!("fsync dir {}: {e}", dir.display()))?;
    Ok(())
}

/// fsyncs every regular file directly inside `dir` (non-recursive), then
/// the directory entry itself. Used after a segment's data files are
/// written (page cache) to make them durable (plan §2.4 step 3 /
/// §2.5) before the manifest that references them is published.
pub fn fsync_segment_dir(dir: &Path) -> Result<()> {
    for entry in
        std::fs::read_dir(dir).map_err(|e| store_err!("read_dir {}: {e}", dir.display()))?
    {
        let entry = entry?;
        if entry.file_type()?.is_file() {
            let f = std::fs::File::open(entry.path())?;
            f.sync_all()?;
        }
    }
    fsync_dir(dir)
}
