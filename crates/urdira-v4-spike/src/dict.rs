//! First-seen-order dictionaries used to turn v3's TEXT ids into the small
//! integer ordinals the v4 shape stores instead.

use std::collections::HashMap;

#[derive(Default, Clone)]
pub struct StringDict {
    pub values: Vec<String>,
    index: HashMap<String, u32>,
}

impl StringDict {
    pub fn intern(&mut self, s: &str) -> u32 {
        if let Some(&id) = self.index.get(s) {
            return id;
        }
        let id = self.values.len() as u32;
        self.values.push(s.to_string());
        self.index.insert(s.to_string(), id);
        id
    }

    #[allow(dead_code)] // diagnostic convenience, not on every call path
    pub fn len(&self) -> usize {
        self.values.len()
    }
}

/// A dictionary keyed by a fixed-size byte digest (used for the relation
/// subject-id space: sha256 of the subject id text).
#[derive(Default)]
pub struct BytesDict32 {
    // Sorted, deduplicated at `finish()`. Before that, `pending` collects
    // every key seen (with duplicates) and `finish` sorts+dedups+builds the
    // lookup index used to resolve ordinals for the second pass.
    pending: Vec<[u8; 32]>,
    pub sorted: Vec<[u8; 32]>,
}

impl BytesDict32 {
    pub fn observe(&mut self, key: [u8; 32]) {
        self.pending.push(key);
    }

    pub fn finish(&mut self) {
        self.pending.sort_unstable();
        self.pending.dedup();
        self.sorted = std::mem::take(&mut self.pending);
    }

    pub fn ordinal(&self, key: &[u8; 32]) -> Option<u32> {
        self.sorted.binary_search(key).ok().map(|i| i as u32)
    }

    pub fn len(&self) -> usize {
        self.sorted.len()
    }
}
