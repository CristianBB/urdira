//! Thin wrapper around `xxhash-rust`'s xxh3 for per-file integrity hashes
//! (plan §2.2/§2.6: "xxh3 per file in the header, verified on open").

pub fn hash(data: &[u8]) -> u64 {
    xxhash_rust::xxh3::xxh3_64(data)
}
