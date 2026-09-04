//! Maps a resolved `SiteOutcome::WorkspaceTarget` back to the caller's own
//! entity id.
//!
//! Entity identity, per `packages/plugin-javascript-typescript/src/
//! analyzer.ts`'s `stableId` (`jsts:{kind}:{path}:{start}:{name}`,
//! `analyzer.ts:685-687`) and its Rust mirror
//! (`crates/urdira-jsts-syntax-worker/src/semantic_sites.rs`'s
//! `declaration_id`, `:431`), is anchored on `(path, name identifier start)`
//! — the declaration's own KIND and NAME are already baked into the id
//! string once built, but are not needed to LOOK ONE UP: two different
//! entities never share the same `(path, name_start)` pair (a name
//! identifier can start at only one position). `crate::resolver::
//! ResidualResolver` already computes `name_identifier_start` the exact
//! same way (`constructor_keyword_start` for a `ConstructorDeclaration`,
//! matching `analyzer.ts:1789-1793`; the first immediate `Identifier`/
//! `PrivateIdentifier` child otherwise — see `crate::node::RemoteSourceFile
//! ::name_start`'s doc comment for the one documented divergence), so an
//! exact-match lookup on that pair is sufficient for this crate's purposes: it
//! never needs to construct the `jsts:...` id string itself, only to look
//! one up that the caller already built from its own entity table.
//!
//! This module does no I/O and holds no reference to any `TsgoClient`,
//! `VirtualFs`, or `WindowPlan` — it exists purely because the mapping is
//! useful next to `crate::residual_pass::SiteOutcome`, not because it needs
//! anything else in this crate.

use std::collections::HashMap;

/// An exact `(path, name_identifier_start)` -> entity id lookup, built once
/// from the caller's own entity table (however that table is populated —
/// this crate has no opinion) and reused across every site a residual pass
/// resolves.
#[derive(Debug, Default)]
pub struct EntityIndex {
    by_path_and_start: HashMap<(String, i32), String>,
    /// Same keys as `by_path_and_start`, but with the path lowercased —
    /// see `lookup`'s doc comment for why a second, case-folded index is
    /// necessary here specifically (not merely a defensive extra): tsgo
    /// itself, not this crate's own path handling, is what erases case,
    /// so there is no "just don't lowercase" fix available upstream of
    /// this lookup. A path collision under lowercasing (two real,
    /// differently-cased paths that happen to name the same
    /// `(path, name_start)` pair once folded) is vanishingly unlikely for
    /// real source trees and, if it ever happens, only affects the
    /// FALLBACK arm (the exact-case index above is tried first and is
    /// always correct) — last-write-wins, same as the primary index.
    by_lower_path_and_start: HashMap<(String, i32), String>,
}

impl EntityIndex {
    /// Builds an index from `(path, name_start_utf16, entity_id)` triples.
    /// A later duplicate `(path, name_start)` pair overwrites an earlier
    /// one's `entity_id` — the caller's own entity table is expected to
    /// already be free of such collisions (an entity's name-identifier
    /// position is unique within its file); this constructor does not
    /// re-validate that.
    pub fn build<I>(entries: I) -> Self
    where
        I: IntoIterator<Item = (String, i32, String)>,
    {
        let mut by_path_and_start = HashMap::new();
        let mut by_lower_path_and_start = HashMap::new();
        for (path, name_start_utf16, entity_id) in entries {
            by_lower_path_and_start.insert(
                (path.to_ascii_lowercase(), name_start_utf16),
                entity_id.clone(),
            );
            by_path_and_start.insert((path, name_start_utf16), entity_id);
        }
        Self {
            by_path_and_start,
            by_lower_path_and_start,
        }
    }

    /// Looks up the entity id for a declaration named at `name_start_utf16`
    /// in `path`. Tries an exact-case match first; if that misses, retries
    /// with `path` lowercased against a second, lowercased-key index built
    /// at construction time — **required**, not merely defensive, because
    /// tsgo's own `useCaseSensitiveFileNames: false` behavior on a
    /// case-insensitive host (confirmed live,
    /// `docs/evidence/2026-09-03-v4-p1d-b-residual-pass.md` §2) lowercases
    /// every absolute path it hands back in a declaration handle —
    /// including a virtual workspace file, not just a real on-disk lib
    /// file — so `crate::residual_pass::SiteOutcome::WorkspaceTarget.path`
    /// for a target file with ANY uppercase character (e.g. n8n's own
    /// `HttpRequest.node.ts`-style PascalCase filenames) never matches
    /// this index's real-case keys at all without this fallback. Returns
    /// `None` only if NEITHER index has an entry at that position — e.g.
    /// the declaration is in a file outside the caller's entity table's
    /// scope, or `name_start_utf16` disagrees with the entity table's own
    /// identity computation for that declaration (see
    /// `crate::node::RemoteSourceFile::name_start`'s documented divergence
    /// for `ComputedPropertyName`/destructuring names).
    pub fn lookup(&self, path: &str, name_start_utf16: i32) -> Option<&str> {
        if let Some(id) = self
            .by_path_and_start
            .get(&(path.to_string(), name_start_utf16))
        {
            return Some(id.as_str());
        }
        self.by_lower_path_and_start
            .get(&(path.to_ascii_lowercase(), name_start_utf16))
            .map(String::as_str)
    }

    /// Convenience over `lookup` for a `crate::residual_pass::SiteOutcome::
    /// WorkspaceTarget` — returns `None` for any other outcome variant
    /// (there is nothing to look up for `External`/`Unresolved`).
    pub fn lookup_workspace_target(
        &self,
        outcome: &crate::residual_pass::SiteOutcome,
    ) -> Option<&str> {
        match outcome {
            crate::residual_pass::SiteOutcome::WorkspaceTarget {
                path,
                name_start_utf16,
                ..
            } => self.lookup(path, *name_start_utf16),
            _ => None,
        }
    }

    pub fn len(&self) -> usize {
        self.by_path_and_start.len()
    }

    pub fn is_empty(&self) -> bool {
        self.by_path_and_start.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::residual_pass::SiteOutcome;

    #[test]
    fn exact_match_lookup() {
        let index = EntityIndex::build([
            (
                "/a.ts".to_string(),
                10,
                "jsts:class:/a.ts:10:Foo".to_string(),
            ),
            (
                "/a.ts".to_string(),
                40,
                "jsts:method:/a.ts:40:bar".to_string(),
            ),
            (
                "/b.ts".to_string(),
                10,
                "jsts:class:/b.ts:10:Baz".to_string(),
            ),
        ]);
        assert_eq!(index.len(), 3);
        assert_eq!(index.lookup("/a.ts", 10), Some("jsts:class:/a.ts:10:Foo"));
        assert_eq!(index.lookup("/a.ts", 40), Some("jsts:method:/a.ts:40:bar"));
        assert_eq!(index.lookup("/b.ts", 10), Some("jsts:class:/b.ts:10:Baz"));
        // Same start, different path -- must not collide.
        assert_ne!(index.lookup("/a.ts", 10), index.lookup("/b.ts", 10));
        assert_eq!(index.lookup("/a.ts", 999), None);
        assert_eq!(index.lookup("/missing.ts", 10), None);
    }

    #[test]
    fn lowercased_target_path_still_resolves_case_insensitively() {
        // Mirrors tsgo's own `useCaseSensitiveFileNames: false` behavior
        // (see this module's `lookup` doc comment): the caller's entity
        // table is built from the REAL, mixed-case path, but a resolved
        // `SiteOutcome::WorkspaceTarget.path` for the same file can come
        // back all-lowercase.
        let index = EntityIndex::build([(
            "/urdira-residual-pass/packages/nodes/HttpRequest.node.ts".to_string(),
            42,
            "jsts:class:.../HttpRequest.node.ts:42:HttpRequest".to_string(),
        )]);
        assert_eq!(
            index.lookup(
                "/urdira-residual-pass/packages/nodes/HttpRequest.node.ts",
                42
            ),
            Some("jsts:class:.../HttpRequest.node.ts:42:HttpRequest")
        );
        // The tsgo-lowercased form of the exact same path.
        assert_eq!(
            index.lookup(
                "/urdira-residual-pass/packages/nodes/httprequest.node.ts",
                42
            ),
            Some("jsts:class:.../HttpRequest.node.ts:42:HttpRequest")
        );
        // A genuinely different path must still miss.
        assert_eq!(
            index.lookup("/urdira-residual-pass/packages/nodes/other.node.ts", 42),
            None
        );
    }

    #[test]
    fn later_duplicate_wins() {
        let index = EntityIndex::build([
            ("/a.ts".to_string(), 10, "first".to_string()),
            ("/a.ts".to_string(), 10, "second".to_string()),
        ]);
        assert_eq!(index.lookup("/a.ts", 10), Some("second"));
    }

    #[test]
    fn lookup_workspace_target_ignores_other_outcomes() {
        let index = EntityIndex::build([(
            "/a.ts".to_string(),
            10,
            "jsts:class:/a.ts:10:Foo".to_string(),
        )]);
        let workspace = SiteOutcome::WorkspaceTarget {
            path: "/a.ts".to_string(),
            name_start_utf16: 10,
            decl_start: 0,
            decl_end: 20,
            kind_hint: 264,
        };
        assert_eq!(
            index.lookup_workspace_target(&workspace),
            Some("jsts:class:/a.ts:10:Foo")
        );
        let external = SiteOutcome::External {
            lib_file: "lib.es5.d.ts".to_string(),
            symbol_name: "Array".to_string(),
        };
        assert_eq!(index.lookup_workspace_target(&external), None);
        let unresolved = SiteOutcome::Unresolved {
            reason: "x".to_string(),
        };
        assert_eq!(index.lookup_workspace_target(&unresolved), None);
    }
}
