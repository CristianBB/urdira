//! Crate-wide error type. Kept as a plain string wrapper (mirrors
//! `urdira_indexing_core::CoreError`) since callers mostly propagate these
//! with `?` and print them; no caller in this crate's tests matches on
//! error variants.

use std::fmt;

#[derive(Debug)]
pub struct StoreError(pub String);

impl fmt::Display for StoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for StoreError {}

impl From<std::io::Error> for StoreError {
    fn from(value: std::io::Error) -> Self {
        StoreError(value.to_string())
    }
}

impl From<serde_json::Error> for StoreError {
    fn from(value: serde_json::Error) -> Self {
        StoreError(value.to_string())
    }
}

impl From<urdira_indexing_core::CoreError> for StoreError {
    fn from(value: urdira_indexing_core::CoreError) -> Self {
        StoreError(value.0)
    }
}

pub type Result<T> = std::result::Result<T, StoreError>;

/// Constructs a [`StoreError`] with a formatted message (avoids importing
/// `format!` at every call site).
macro_rules! store_err {
    ($($arg:tt)*) => {
        $crate::error::StoreError(format!($($arg)*))
    };
}
pub(crate) use store_err;
