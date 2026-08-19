//! A small lending domain used by the Urdira end-to-end fixture corpus.

pub mod domain;
pub mod repository;
pub mod service;

pub use domain::{Book, Loan, LoanError, Member};
pub use repository::{InMemoryLibrary, LibraryRepository};
pub use service::LendingService;
