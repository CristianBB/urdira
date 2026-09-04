//! A3a-fix reporting helper (ignored by default): opens a real store and
//! prints a histogram of `records.meta`'s `IDENTITY_LAYOUT` tag across
//! every visible row at the store's current generation -- cheap read-only
//! inspection via `RecordView::identity_layout()`, no decoding of any
//! identity key needed. Run with:
//!
//! ```text
//! URDIRA_INSPECT_LAYOUT_STORE=/path/to/structural cargo test --release \
//!   -p urdira-structural-store --test inspect_layout_histogram -- \
//!   --ignored --nocapture
//! ```

use urdira_structural_store::StoreReader;

#[test]
#[ignore]
fn inspect_layout_histogram() {
    let Some(dir) = std::env::var_os("URDIRA_INSPECT_LAYOUT_STORE") else {
        eprintln!("set URDIRA_INSPECT_LAYOUT_STORE to a structural store directory to run this");
        return;
    };
    let reader = StoreReader::open(std::path::Path::new(&dir)).expect("open store");
    let g = reader.generation();
    let mut raw = 0u64;
    let mut entity = 0u64;
    let mut relation = 0u64;
    let mut relation_no_span = 0u64;
    let mut other = 0u64;
    let mut total = 0u64;
    for view in reader.iter_visible(g) {
        total += 1;
        match view.identity_layout() {
            0 => raw += 1,
            1 => entity += 1,
            2 => relation += 1,
            3 => relation_no_span += 1,
            _ => other += 1,
        }
    }
    println!(
        "generation={g} total={total} RAW={raw} ENTITY={entity} RELATION={relation} \
         RELATION_NO_SPAN={relation_no_span} OTHER={other} \
         raw_pct={:.2}%",
        100.0 * raw as f64 / total.max(1) as f64
    );
}
