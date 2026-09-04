use std::path::Path;
use std::time::Duration;

#[derive(Debug, Clone, Copy)]
pub struct Timings {
    pub to_page_cache: Duration,
    pub durable: Duration,
    pub bytes_written: u64,
}

impl Timings {
    pub fn report(&self, label: &str) {
        println!(
            "RESULT {label} page_cache_ms={:.1} durable_ms={:.1} bytes={}",
            self.to_page_cache.as_secs_f64() * 1000.0,
            self.durable.as_secs_f64() * 1000.0,
            self.bytes_written
        );
    }
}

pub fn dir_size(path: &Path) -> std::io::Result<u64> {
    let mut total = 0u64;
    if path.is_file() {
        return Ok(std::fs::metadata(path)?.len());
    }
    for entry in std::fs::read_dir(path)? {
        let entry = entry?;
        let meta = entry.metadata()?;
        if meta.is_dir() {
            total += dir_size(&entry.path())?;
        } else {
            total += meta.len();
        }
    }
    Ok(total)
}

pub fn fsync_path(path: &Path) -> std::io::Result<()> {
    if path.is_dir() {
        for entry in std::fs::read_dir(path)? {
            let entry = entry?;
            if entry.metadata()?.is_file() {
                std::fs::File::open(entry.path())?.sync_all()?;
            }
        }
        // Best-effort directory entry durability.
        if let Ok(dirf) = std::fs::File::open(path) {
            let _ = dirf.sync_all();
        }
    } else {
        std::fs::File::open(path)?.sync_all()?;
        if let Some(parent) = path.parent()
            && let Ok(dirf) = std::fs::File::open(parent)
        {
            let _ = dirf.sync_all();
        }
    }
    Ok(())
}

pub fn remove_if_exists(path: &Path) {
    if path.is_dir() {
        let _ = std::fs::remove_dir_all(path);
    } else {
        let _ = std::fs::remove_file(path);
        let wal = path.with_extension("sqlite-wal");
        let shm = path.with_extension("sqlite-shm");
        let _ = std::fs::remove_file(wal);
        let _ = std::fs::remove_file(shm);
    }
}
