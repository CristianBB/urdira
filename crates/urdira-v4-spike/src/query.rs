//! `query` subcommand: 100-sample latency measurements per workload, run
//! against a target already built by replay-a/b/c. Sample keys (which
//! record id / owner / name / subject to look up) are drawn once from the
//! FULL or NODIAG row cache with a fixed seed, so the *same* 100 samples are
//! used across A, B and C -- an apples-to-apples comparison, not three
//! independent random draws.

use crate::AnyResult;
use crate::replay_c::CStore;
use crate::row::{CATEGORY_ENTITY, NONE_U32, Store};
use rand::rngs::StdRng;
use rand::{Rng, SeedableRng};
use rusqlite::{Connection, OpenFlags};
use std::path::Path;
use std::time::Instant;

const SAMPLES: usize = 100;

struct Samples {
    record_ids: Vec<[u8; 32]>,
    owners: Vec<u32>,
    names: Vec<u32>,
    subjects: Vec<u32>,
    selector_universal_kind_id: u16,
    selector_category: u8,
    selector_kind_id: u16,
}

fn build_samples(store: &Store) -> Samples {
    let mut rng = StdRng::seed_from_u64(42);
    let n = store.rows.len();
    let mut record_ids = Vec::with_capacity(SAMPLES);
    let mut owners = Vec::with_capacity(SAMPLES);
    let mut names = Vec::with_capacity(SAMPLES);
    for _ in 0..SAMPLES {
        let row = &store.rows[rng.random_range(0..n)];
        record_ids.push(row.record_id);
        owners.push(row.owner_artifact);
        names.push(row.name_id);
    }
    let n_subjects = store.dict.subjects.len();
    let subjects: Vec<u32> = (0..SAMPLES)
        .map(|_| rng.random_range(0..n_subjects as u32))
        .collect();

    let selector_kind_id = store
        .dict
        .kinds
        .iter()
        .position(|s| s == "jsts:entity_variable")
        .expect("jsts:entity_variable kind present") as u16;
    let selector_universal_kind_id = store
        .rows
        .iter()
        .find(|r| r.kind_id == selector_kind_id)
        .map(|r| r.universal_kind_id)
        .expect("a row with the selector kind exists");

    Samples {
        record_ids,
        owners,
        names,
        subjects,
        selector_universal_kind_id,
        selector_category: CATEGORY_ENTITY,
        selector_kind_id,
    }
}

fn percentiles(mut v: Vec<u64>) -> (f64, f64) {
    v.sort_unstable();
    let n = v.len();
    let p50 = v[n / 2] as f64;
    let p95_idx = ((n as f64 * 0.95) as usize).min(n - 1);
    let p95 = v[p95_idx] as f64;
    (p50, p95)
}

fn report(label: &str, durations_us: Vec<u64>) {
    let (p50, p95) = percentiles(durations_us);
    println!("QUERY {label} p50_us={p50:.1} p95_us={p95:.1}");
}

fn time_it<F: FnMut() -> usize>(mut f: F) -> (u64, usize) {
    let t = Instant::now();
    let touched = f();
    (t.elapsed().as_micros() as u64, touched)
}

// --- SQLite backends (A: one file, B: three files) -----------------------

trait Backend {
    fn by_record_id(&self, id: &[u8; 32]) -> usize;
    fn by_owner(&self, owner: u32) -> usize;
    fn by_name(&self, name: u32) -> usize;
    fn adjacency_out(&self, subject: u32) -> usize;
    fn adjacency_in(&self, subject: u32) -> usize;
    fn selector(&self, universal_kind_id: u16, category: u8, kind_id: u16) -> usize;
    fn visible_count(&self) -> usize;
    fn two_hop(&self, subject: u32) -> usize;
}

struct SqliteA {
    conn: Connection,
}

impl SqliteA {
    fn open(path: &Path) -> AnyResult<Self> {
        let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        Ok(Self { conn })
    }
}

impl Backend for SqliteA {
    fn by_record_id(&self, id: &[u8; 32]) -> usize {
        self.conn
            .query_row(
                "SELECT length(body_payload) FROM record_occurrences WHERE record_id = ?1",
                rusqlite::params![id.as_slice()],
                |r| r.get::<_, i64>(0),
            )
            .map(|v| v as usize)
            .unwrap_or(0)
    }
    fn by_owner(&self, owner: u32) -> usize {
        let mut stmt = self
            .conn
            .prepare_cached(
                "SELECT COUNT(*) FROM record_occurrences \
                 WHERE owner_artifact = ?1 AND valid_to_generation IS NULL",
            )
            .unwrap();
        stmt.query_row(rusqlite::params![owner], |r| r.get::<_, i64>(0))
            .unwrap_or(0) as usize
    }
    fn by_name(&self, name: u32) -> usize {
        let mut stmt = self
            .conn
            .prepare_cached("SELECT COUNT(*) FROM record_occurrences WHERE name_id = ?1")
            .unwrap();
        stmt.query_row(rusqlite::params![name], |r| r.get::<_, i64>(0))
            .unwrap_or(0) as usize
    }
    fn adjacency_out(&self, subject: u32) -> usize {
        let mut stmt = self
            .conn
            .prepare_cached(
                "SELECT COUNT(*) FROM record_occurrences \
                 WHERE source_subject = ?1 AND valid_to_generation IS NULL",
            )
            .unwrap();
        stmt.query_row(rusqlite::params![subject], |r| r.get::<_, i64>(0))
            .unwrap_or(0) as usize
    }
    fn adjacency_in(&self, subject: u32) -> usize {
        let mut stmt = self
            .conn
            .prepare_cached(
                "SELECT COUNT(*) FROM record_occurrences \
                 WHERE target_subject = ?1 AND valid_to_generation IS NULL",
            )
            .unwrap();
        stmt.query_row(rusqlite::params![subject], |r| r.get::<_, i64>(0))
            .unwrap_or(0) as usize
    }
    fn selector(&self, universal_kind_id: u16, category: u8, kind_id: u16) -> usize {
        let mut stmt = self
            .conn
            .prepare_cached(
                "SELECT record_id FROM record_occurrences \
                 WHERE universal_kind_id = ?1 AND category = ?2 AND kind_id = ?3 \
                 ORDER BY record_id LIMIT 1000",
            )
            .unwrap();
        stmt.query_map(
            rusqlite::params![universal_kind_id, category, kind_id],
            |_| Ok(()),
        )
        .unwrap()
        .count()
    }
    fn visible_count(&self) -> usize {
        self.conn
            .query_row(
                "SELECT COUNT(*) FROM record_occurrences WHERE valid_to_generation IS NULL",
                [],
                |r| r.get::<_, i64>(0),
            )
            .unwrap_or(0) as usize
    }
    fn two_hop(&self, subject: u32) -> usize {
        two_hop_via(
            |s| {
                self.query_targets(
                    "SELECT DISTINCT target_subject FROM record_occurrences \
                     WHERE source_subject = ?1 AND valid_to_generation IS NULL",
                    s,
                )
            },
            subject,
        )
    }
}

impl SqliteA {
    fn query_targets(&self, sql: &str, subject: u32) -> Vec<u32> {
        let mut stmt = self.conn.prepare_cached(sql).unwrap();
        stmt.query_map(rusqlite::params![subject], |r| r.get::<_, i64>(0))
            .unwrap()
            .filter_map(|v| v.ok())
            .map(|v| v as u32)
            .collect()
    }
}

fn two_hop_via(mut out_of: impl FnMut(u32) -> Vec<u32>, subject: u32) -> usize {
    use std::collections::HashSet;
    let hop1 = out_of(subject);
    let mut seen: HashSet<u32> = hop1.iter().copied().collect();
    for s in hop1 {
        for t in out_of(s) {
            seen.insert(t);
        }
    }
    seen.len()
}

struct SqliteB {
    records: Connection,
    lookup: Connection,
    adjacency: Connection,
}

impl SqliteB {
    fn open(dir: &Path) -> AnyResult<Self> {
        let flags = OpenFlags::SQLITE_OPEN_READ_ONLY;
        Ok(Self {
            records: Connection::open_with_flags(dir.join("records.sqlite"), flags)?,
            lookup: Connection::open_with_flags(dir.join("lookup.sqlite"), flags)?,
            adjacency: Connection::open_with_flags(dir.join("adjacency.sqlite"), flags)?,
        })
    }
}

impl Backend for SqliteB {
    fn by_record_id(&self, id: &[u8; 32]) -> usize {
        self.records
            .query_row(
                "SELECT length(body_payload) FROM record_occurrences WHERE record_id = ?1",
                rusqlite::params![id.as_slice()],
                |r| r.get::<_, i64>(0),
            )
            .map(|v| v as usize)
            .unwrap_or(0)
    }
    fn by_owner(&self, owner: u32) -> usize {
        self.records
            .query_row(
                "SELECT COUNT(*) FROM record_occurrences \
                 WHERE owner_artifact = ?1 AND valid_to_generation IS NULL",
                rusqlite::params![owner],
                |r| r.get::<_, i64>(0),
            )
            .unwrap_or(0) as usize
    }
    fn by_name(&self, name: u32) -> usize {
        self.lookup
            .query_row(
                "SELECT COUNT(*) FROM record_occurrences WHERE name_id = ?1",
                rusqlite::params![name],
                |r| r.get::<_, i64>(0),
            )
            .unwrap_or(0) as usize
    }
    fn adjacency_out(&self, subject: u32) -> usize {
        self.adjacency
            .query_row(
                "SELECT COUNT(*) FROM record_occurrences \
                 WHERE source_subject = ?1 AND valid_to_generation IS NULL",
                rusqlite::params![subject],
                |r| r.get::<_, i64>(0),
            )
            .unwrap_or(0) as usize
    }
    fn adjacency_in(&self, subject: u32) -> usize {
        self.adjacency
            .query_row(
                "SELECT COUNT(*) FROM record_occurrences \
                 WHERE target_subject = ?1 AND valid_to_generation IS NULL",
                rusqlite::params![subject],
                |r| r.get::<_, i64>(0),
            )
            .unwrap_or(0) as usize
    }
    fn selector(&self, universal_kind_id: u16, category: u8, kind_id: u16) -> usize {
        let mut stmt = self
            .lookup
            .prepare_cached(
                "SELECT record_id FROM record_occurrences \
                 WHERE universal_kind_id = ?1 AND category = ?2 AND kind_id = ?3 \
                 ORDER BY record_id LIMIT 1000",
            )
            .unwrap();
        stmt.query_map(
            rusqlite::params![universal_kind_id, category, kind_id],
            |_| Ok(()),
        )
        .unwrap()
        .count()
    }
    fn visible_count(&self) -> usize {
        self.records
            .query_row(
                "SELECT COUNT(*) FROM record_occurrences WHERE valid_to_generation IS NULL",
                [],
                |r| r.get::<_, i64>(0),
            )
            .unwrap_or(0) as usize
    }
    fn two_hop(&self, subject: u32) -> usize {
        two_hop_via(
            |s| {
                let mut stmt = self
                    .adjacency
                    .prepare_cached(
                        "SELECT DISTINCT target_subject FROM record_occurrences \
                         WHERE source_subject = ?1 AND valid_to_generation IS NULL",
                    )
                    .unwrap();
                stmt.query_map(rusqlite::params![s], |r| r.get::<_, i64>(0))
                    .unwrap()
                    .filter_map(|v| v.ok())
                    .map(|v| v as u32)
                    .collect()
            },
            subject,
        )
    }
}

struct CBackend {
    store: CStore,
}

impl Backend for CBackend {
    fn by_record_id(&self, id: &[u8; 32]) -> usize {
        match self.store.find_record(id) {
            Some(k) => self.store.body_at(k).len(),
            None => 0,
        }
    }
    fn by_owner(&self, owner: u32) -> usize {
        self.store
            .range_by_owner(owner)
            .into_iter()
            .filter(|&k| {
                let m = self.store.meta_at(k as usize);
                crate::layout::u32le(m, crate::layout::meta::VALID_TO) == 0
            })
            .count()
    }
    fn by_name(&self, name: u32) -> usize {
        self.store.range_by_name(name).len()
    }
    fn adjacency_out(&self, subject: u32) -> usize {
        self.store
            .range_adj_out(subject)
            .into_iter()
            .filter(|&k| {
                let m = self.store.meta_at(k as usize);
                crate::layout::u32le(m, crate::layout::meta::VALID_TO) == 0
            })
            .count()
    }
    fn adjacency_in(&self, subject: u32) -> usize {
        self.store
            .range_adj_in(subject)
            .into_iter()
            .filter(|&k| {
                let m = self.store.meta_at(k as usize);
                crate::layout::u32le(m, crate::layout::meta::VALID_TO) == 0
            })
            .count()
    }
    fn selector(&self, universal_kind_id: u16, category: u8, kind_id: u16) -> usize {
        let mut ks = self
            .store
            .range_by_kind(universal_kind_id, category, kind_id);
        ks.sort_unstable(); // row_ordinal order == record_id order
        ks.truncate(1000);
        ks.len()
    }
    fn visible_count(&self) -> usize {
        (0..self.store.n)
            .filter(|&k| {
                crate::layout::u32le(self.store.meta_at(k), crate::layout::meta::VALID_TO) == 0
            })
            .count()
    }
    fn two_hop(&self, subject: u32) -> usize {
        // adj.out/adj.in row_ordinals point at rows in the *records.keys*
        // order, but the subject dimension is the subject dictionary, not
        // row ordinals -- to hop again we need each row's target_subject.
        two_hop_via(
            |s| {
                self.store
                    .range_adj_out(s)
                    .into_iter()
                    .map(|k| {
                        crate::layout::u32le(
                            self.store.meta_at(k as usize),
                            crate::layout::meta::TARGET_SUBJECT,
                        )
                    })
                    .collect()
            },
            subject,
        )
    }
}

pub fn run(target: &str, cache_path: &Path, store_path: &Path) -> AnyResult<()> {
    let load_t0 = Instant::now();
    let store = crate::row::load_store(cache_path)?;
    eprintln!(
        "[query] loaded sample cache {} ({} rows) in {:?}",
        cache_path.display(),
        store.rows.len(),
        load_t0.elapsed()
    );
    let samples = build_samples(&store);

    let open_t0 = Instant::now();
    let backend: Box<dyn Backend> = match target {
        "a" => Box::new(SqliteA::open(store_path)?),
        "b" => Box::new(SqliteB::open(store_path)?),
        "c" => Box::new(CBackend {
            store: CStore::open(store_path)?,
        }),
        other => anyhow_bail(other),
    };
    let open_ms = open_t0.elapsed().as_secs_f64() * 1000.0;
    println!("QUERY open_ms={open_ms:.2}");

    // First query (record_id lookup #0) reported separately as the
    // fresh-process "first query" number, then folded into the normal
    // by_record_id sample set for the warm p50/p95.
    let (first_us, _) = time_it(|| backend.by_record_id(&samples.record_ids[0]));
    println!("QUERY first_query_us={first_us}");

    let mut d = Vec::with_capacity(SAMPLES);
    for id in &samples.record_ids {
        let (us, _) = time_it(|| backend.by_record_id(id));
        d.push(us);
    }
    report("by_record_id", d);

    let mut d = Vec::with_capacity(SAMPLES);
    for &owner in &samples.owners {
        let (us, _) = time_it(|| backend.by_owner(owner));
        d.push(us);
    }
    report("by_owner", d);

    let mut d = Vec::with_capacity(SAMPLES);
    for &name in &samples.names {
        if name == NONE_U32 {
            continue;
        }
        let (us, _) = time_it(|| backend.by_name(name));
        d.push(us);
    }
    report("by_name", d);

    let mut d = Vec::with_capacity(SAMPLES);
    for &s in &samples.subjects {
        let (us, _) = time_it(|| backend.adjacency_out(s));
        d.push(us);
    }
    report("adjacency_out", d);

    let mut d = Vec::with_capacity(SAMPLES);
    for &s in &samples.subjects {
        let (us, _) = time_it(|| backend.adjacency_in(s));
        d.push(us);
    }
    report("adjacency_in", d);

    let mut d = Vec::with_capacity(SAMPLES);
    for _ in 0..SAMPLES {
        let (us, _) = time_it(|| {
            backend.selector(
                samples.selector_universal_kind_id,
                samples.selector_category,
                samples.selector_kind_id,
            )
        });
        d.push(us);
    }
    report("selector_entity_variable_limit1000", d);

    let mut d = Vec::with_capacity(SAMPLES);
    for _ in 0..SAMPLES {
        let (us, _) = time_it(|| backend.visible_count());
        d.push(us);
    }
    report("visible_count", d);

    let mut d = Vec::with_capacity(SAMPLES);
    for &s in &samples.subjects {
        let (us, _) = time_it(|| backend.two_hop(s));
        d.push(us);
    }
    report("two_hop", d);

    Ok(())
}

fn anyhow_bail(target: &str) -> ! {
    eprintln!("unknown query target: {target}");
    std::process::exit(2)
}
