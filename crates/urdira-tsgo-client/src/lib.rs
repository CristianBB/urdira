//! A Rust client for the TypeScript 7 ("tsgo", the Go port of the
//! TypeScript checker) async API mode — task P1-D-a of the urdira v4 plan.
//!
//! `tsgo --api --async` exposes a JSON-RPC-over-stdio interface to a full
//! `ts.Program`/checker for a virtual (in-memory) project, driven by
//! server-to-client callbacks for filesystem access
//! (`crate::virtual_fs::VirtualFs`). This crate exists so a future
//! background residual-resolution pass in the indexing worker can talk to
//! that checker directly from Rust, without spawning the Node semantic
//! worker (`packages/plugin-javascript-typescript`) that currently owns
//! this integration for the live analysis path.
//!
//! # Module map
//!
//! - [`binary`] — locates the `tsgo`/`tsc` executable and pins the exact
//!   npm package version it came from.
//! - [`rpc`] — the `Content-Length`-framed JSON-RPC 2.0 codec.
//! - [`virtual_fs`] — the FS callback surface tsgo calls back into.
//! - [`proto`] — typed request/response shapes for the subset of the API
//!   this crate uses.
//! - [`client`] — [`client::TsgoClient`], the spawned process + connection.
//! - [`node`] — the binary AST payload decoder
//!   ([`node::RemoteSourceFile`]) and node handles.
//! - [`trivia`] — the leading-trivia skipper used to turn a node's `pos`
//!   into its `getStart()`.
//! - [`resolver`] — [`resolver::ResidualResolver`], the pure
//!   resolution logic this whole crate exists to run.
//! - [`residual_pass`] — task P1-D-b: [`residual_pass::WindowPlan`] (splits
//!   the full sorted root list into fixed-size windows) and
//!   [`residual_pass::ResidualPass`] (runs `lanes` parallel `TsgoClient`
//!   processes over contiguous window blocks, classifying every resolved
//!   declaration as [`residual_pass::SiteOutcome::WorkspaceTarget`] or
//!   [`residual_pass::SiteOutcome::External`]).
//! - [`entity_index`] — [`entity_index::EntityIndex`], mapping a
//!   `WorkspaceTarget` back to a caller-supplied entity id by exact
//!   `(path, name_identifier_start)`.
//!
//! `crate::virtual_fs::LayeredFs`/`OverlayFs` (still in [`virtual_fs`],
//! since they implement that module's own trait) are what make P1-D-b's
//! lib-file resolution and per-window project-config rewriting possible —
//! see their doc comments.
//!
//! # What is deliberately out of scope
//!
//! This crate does not implement diagnostics (syntactic, semantic, or
//! otherwise), emit, completions, or most of the `Checker`'s type-level
//! surface (only `getTypeAtLocations`/`typeToString` are wired, and only
//! because the task brief asked for them as optional). It also does not
//! implement the sync (msgpack) channel — only the async JSON-RPC one.
//!
//! # Versioning risk
//!
//! The wire protocol has no version negotiation beyond the single
//! `PROTOCOL_VERSION` byte embedded in each binary AST payload
//! ([`node::PROTOCOL_VERSION`], asserted in [`node::RemoteSourceFile::decode`]).
//! Everything else in this client — JSON-RPC method names, request/response
//! field names, the binary header/node-table layout — was reverse-engineered
//! from `typescript@7.0.2`'s own JS reference client
//! (`dist/api/async/*.js`, `dist/api/node/*.js`) rather than from any
//! published schema, because none exists. A `typescript` package upgrade
//! that changes any of this silently would not be caught by this crate at
//! compile time; see the evidence doc
//! (`docs/evidence/2026-09-03-v4-p1d-a-tsgo-client.md`) for the exact
//! version this was built and tested against, and the [`binary::TsgoVersion`]
//! this crate reports at runtime.

pub mod binary;
pub mod client;
pub mod entity_index;
pub mod node;
pub mod proto;
pub mod residual_pass;
pub mod resolver;
pub mod rpc;
pub mod trivia;
pub mod virtual_fs;

pub use binary::{TsgoBinary, TsgoVersion};
pub use client::{ClientError, TsgoClient};
pub use entity_index::EntityIndex;
pub use node::{NodeHandle, RemoteSourceFile};
pub use residual_pass::{
    PassStats, ResidualPass, ResidualPassConfig, ResidualPassError, ResolvedSite, SiteOutcome,
    Window, WindowPlan, WindowStats,
};
pub use resolver::{PendingSite, ResidualResolver, Resolution, ResolvedDeclaration, SiteKind};
pub use virtual_fs::{LayeredFs, MapFs, OverlayFs, VirtualFs};
