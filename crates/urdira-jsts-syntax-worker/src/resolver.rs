//! Workspace-aware import specifier resolver (design stage E2 of the F5
//! hybrid lane; see `docs/evidence/2026-09-01-f5-hybrid-design.md`, section
//! E2, and `docs/evidence/2026-09-01-f5-e1-veredicto.md`).
//!
//! `resolve_relative` (still exported here, unchanged in behavior) only ever
//! handled a `.`-relative specifier. That left every bare, cross-package
//! specifier inside a pnpm/yarn/npm workspace monorepo (`import { Foo } from
//! "@n8n/workflow"`) permanently unresolved: `direct_imports[].target_path`
//! stayed `None`, `core:import`/`core:export` relations stayed
//! `RelationClassification::Possible`, and dependency closures
//! (`reverse_affected_closure`) never crossed a package boundary. This module
//! closes that gap deterministically, from four kinds of workspace
//! configuration content (`ConfigAsset`s the caller decodes and hands in):
//!
//!   1. A workspace package-name -> root-directory map, built from
//!      `pnpm-workspace.yaml`'s `packages:` glob list and the root
//!      `package.json#workspaces` field (array or `{ packages: [...] }`
//!      object form), matched against every `package.json`'s own directory.
//!   2. Per-package resolution: `exports` (subpaths, one wildcard level,
//!      fixed condition order `["types", "import", "default"]`), falling
//!      back to `main`/`module`/`types` for a bare (no-subpath) specifier
//!      when `exports` is absent or does not resolve.
//!   3. `tsconfig.json`/`jsconfig.json` `compilerOptions.paths`/`baseUrl`,
//!      resolved from the closest config file to the importing module, with
//!      `extends` chains followed (relative and workspace-package-rooted,
//!      cycle-guarded, depth-capped).
//!   4. The existing extension-probing machine (moved here verbatim from
//!      `resolve_relative` as `probe_extensions`/`RESOLUTION_EXTENSIONS`):
//!      every strategy above produces an extension-less *candidate* path,
//!      resolved against the `available` source-path set exactly the same
//!      way a relative specifier already was.
//!
//! Deliberately out of scope (falls through to `None`, i.e.
//! `checker_pending` downstream -- under-resolving is always safe, over-
//! resolving never is):
//!   - third-party `node_modules` packages: this corpus's source manifest
//!     never contains them, by construction of the source frontier;
//!   - package.json `imports` (`#alias`) subpath maps;
//!   - conditional exports beyond `types`/`import`/`default` (no
//!     `require`/`node`/`browser`/... arm -- an ESM+TS-first order matches
//!     how this corpus's own build tooling resolves it; a package that only
//!     exposes, say, `require` under `exports` is left unresolved rather
//!     than guessed at).
//!
//! E2b (injecting these `paths` into the residual tsgo project) is explicitly
//! out of scope here too -- see the design doc's own E2b note.

use crate::{EntityKind, SyntaxExportBinding, SyntaxFileResult};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

/// One resolution-relevant workspace asset handed to the syntax worker
/// alongside its JS/TS sources: `package.json`, `tsconfig.json`/
/// `jsconfig.json`, or `pnpm-workspace.yaml`. `path` is workspace-relative,
/// forward-slash, matching the convention every JS/TS source path already
/// uses. Content is decoded UTF-8 text; the caller (`analyze_config_assets`
/// in `lib.rs`) drops anything that fails digest/UTF-8 validation before
/// construction rather than failing analysis over one malformed file.
#[derive(Debug, Clone)]
pub struct ConfigAsset {
    pub path: String,
    pub content: String,
}

const RESOLUTION_EXTENSIONS: [&str; 11] = [
    ".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts", ".d.ts", ".d.mts", ".d.cts",
];

const MAX_EXTENDS_DEPTH: u8 = 10;

/// Every concrete path `probe_extensions` would test for `base`, in the
/// same order (the exact path, then each extension appended, then each
/// extension appended after `/index`) -- the single authoritative
/// candidate-path enumeration, shared by `probe_extensions` itself and by
/// P3-6 item 2's reverse candidate-path index (`WorkspaceResolver::
/// candidate_paths`, `lib.rs`'s `build_candidate_index`), which needs the
/// same list WITHOUT stopping at the first `available` hit.
fn push_candidate_variants(base: &str, out: &mut Vec<String>) {
    out.push(base.to_owned());
    for extension in RESOLUTION_EXTENSIONS {
        out.push(format!("{base}{extension}"));
    }
    for extension in RESOLUTION_EXTENSIONS {
        out.push(format!("{base}/index{extension}"));
    }
}

/// Probe `base` (an extension-less candidate path) against `available`: the
/// exact path, each extension appended, then each extension appended after
/// `/index`. The single authoritative extension list, shared by every
/// resolution strategy in this module (moved here verbatim from the former
/// `resolve_relative` in `lib.rs`).
fn probe_extensions(available: &BTreeSet<String>, base: &str) -> Option<String> {
    let mut variants = Vec::with_capacity(2 * RESOLUTION_EXTENSIONS.len() + 1);
    push_candidate_variants(base, &mut variants);
    variants
        .into_iter()
        .find(|candidate| available.contains(candidate))
}

fn dirname(path: &str) -> &str {
    match path.rfind('/') {
        Some(index) => &path[..index],
        None => "",
    }
}

/// Join a `/`-separated logical directory (workspace-relative, never touches
/// the real filesystem) against a specifier that may carry `.`/`..`
/// segments.
fn join_relative(from_dir: &str, specifier: &str) -> String {
    let mut parts: Vec<&str> = if from_dir.is_empty() {
        Vec::new()
    } else {
        from_dir.split('/').collect()
    };
    for part in specifier.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            _ => parts.push(part),
        }
    }
    parts.join("/")
}

/// Join a package/tsconfig root directory against a subpath that is always
/// forward-relative (`./x`, `x`, never `..`) -- package manifest fields
/// (`main`, `exports` targets, `paths` targets) are specified this way by
/// convention; a stray `..` in one is treated as a literal segment rather
/// than climbing out of the root, since `join_relative`'s `..`-popping
/// semantics are for specifiers written by an importing module, not for
/// manifest-declared targets.
fn join_subpath(root: &str, subpath: &str) -> String {
    let stripped = subpath.strip_prefix("./").unwrap_or(subpath);
    // A bare "." (as in `"baseUrl": "."`) means "this directory" -- the same
    // as an empty subpath -- but is not covered by the `./` prefix strip
    // above (there's no trailing segment to strip a slash before).
    let trimmed = if stripped == "." { "" } else { stripped };
    if trimmed.is_empty() {
        root.to_owned()
    } else if root.is_empty() {
        trimmed.to_owned()
    } else {
        format!("{root}/{trimmed}")
    }
}

/// Resolve a `.`-relative specifier from `from` against `available`. Exact
/// behavior preserved from the pre-E2 `resolve_relative` (a leading `/` is
/// NOT treated as workspace-root-absolute -- this corpus never produces one).
pub fn resolve_relative(
    available: &BTreeSet<String>,
    from: &str,
    specifier: &str,
) -> Option<String> {
    if !specifier.starts_with('.') {
        return None;
    }
    let base = join_relative(dirname(from), specifier);
    probe_extensions(available, &base)
}

/// Split a bare (non-relative) specifier into `(package_name, subpath)`,
/// honoring scoped packages (`@scope/name/sub` -> package `@scope/name`,
/// `sub`). Returns `None` when `specifier` is relative or does not carry
/// enough segments to name a scoped package.
fn split_bare_specifier(specifier: &str) -> Option<(String, Option<String>)> {
    if specifier.is_empty() || specifier.starts_with('.') {
        return None;
    }
    let mut parts = specifier.splitn(2, '/');
    let first = parts.next()?;
    let rest = parts.next();
    if let Some(scope) = first.strip_prefix('@') {
        let _ = scope;
        let rest = rest?;
        let mut inner = rest.splitn(2, '/');
        let name_segment = inner.next()?;
        let package_name = format!("{first}/{name_segment}");
        let subpath = inner.next().map(str::to_owned);
        Some((package_name, subpath))
    } else {
        Some((first.to_owned(), rest.map(str::to_owned)))
    }
}

/// Match `specifier` (a subpath's remaining wildcard capture target, or a
/// full bare specifier for `paths`) against a single-wildcard `pattern`.
/// Supports at most one `*` in `pattern`, matching the subset both
/// `package.json#exports` subpaths and `tsconfig` `paths` patterns actually
/// use in practice ("básicos" per the design doc). Returns the captured
/// substring on a match.
fn match_wildcard<'a>(pattern: &str, candidate: &'a str) -> Option<&'a str> {
    match pattern.find('*') {
        None => (pattern == candidate).then_some(""),
        Some(star) => {
            let prefix = &pattern[..star];
            let suffix = &pattern[star + 1..];
            if candidate.len() >= prefix.len() + suffix.len()
                && candidate.starts_with(prefix)
                && candidate.ends_with(suffix)
            {
                Some(&candidate[prefix.len()..candidate.len() - suffix.len()])
            } else {
                None
            }
        }
    }
}

fn substitute_wildcard(target: &str, captured: &str) -> String {
    match target.find('*') {
        Some(star) => format!("{}{}{}", &target[..star], captured, &target[star + 1..]),
        None => target.to_owned(),
    }
}

/// Fixed condition order the design doc mandates: types first (so a `.d.ts`
/// companion is preferred when present), then `import` (this corpus's own
/// modules are analyzed as ES modules), then `default`.
const CONDITION_ORDER: [&str; 3] = ["types", "import", "default"];

/// Collect every candidate target `value` (an `exports` leaf or nested
/// conditions object) could name, in `CONDITION_ORDER` priority (an
/// array-of-fallbacks form appends its entries in listed order). Returns a
/// list, not the first match, because this corpus's `available` set is a
/// source-controlled file manifest, not a real filesystem: the highest-
/// priority condition's target (typically `types`, a generated `.d.ts`) is
/// often not itself checked in even though a lower-priority one (`import`)
/// resolves to a real, present file, so the caller must keep trying
/// candidates against `available` rather than committing to the first.
fn collect_condition_candidates(value: &Value, out: &mut Vec<String>) {
    match value {
        Value::String(target) => out.push(target.clone()),
        Value::Array(entries) => {
            for entry in entries {
                collect_condition_candidates(entry, out);
            }
        }
        Value::Object(map) => {
            for condition in CONDITION_ORDER {
                if let Some(inner) = map.get(condition) {
                    collect_condition_candidates(inner, out);
                }
            }
        }
        _ => {}
    }
}

/// Resolve `subpath` (`None` for a bare package specifier) against a
/// package's `exports` field, returning every candidate target in priority
/// order (see `collect_condition_candidates`).
fn resolve_exports_subpath(exports: &Value, subpath: Option<&str>) -> Vec<String> {
    let key = match subpath {
        None => ".".to_owned(),
        Some(rest) => format!("./{rest}"),
    };
    let mut candidates = Vec::new();
    match exports {
        // A bare string/array/conditions-object `exports` value names the
        // package root export directly; only a subpath-less specifier can
        // ever match it.
        Value::String(_) | Value::Array(_) => {
            if subpath.is_none() {
                collect_condition_candidates(exports, &mut candidates);
            }
        }
        Value::Object(map) => {
            // Distinguish a subpath map (`{"./a": ..., "./b": ...}`) from a
            // bare conditions object (`{"types": ..., "import": ...}`) the
            // same way Node does: subpath maps have keys starting with `.`.
            let is_subpath_map = map.keys().any(|candidate| candidate.starts_with('.'));
            if !is_subpath_map {
                if subpath.is_none() {
                    collect_condition_candidates(exports, &mut candidates);
                }
                return candidates;
            }
            if let Some(value) = map.get(key.as_str()) {
                collect_condition_candidates(value, &mut candidates);
                return candidates;
            }
            let rest = subpath.unwrap_or("");
            // The matching wildcard pattern with the longest literal prefix
            // (most specific) wins, tie-broken by key text for determinism;
            // only ITS candidates are tried -- a different, less-specific
            // pattern is never a fallback for a matched one (matches real
            // `exports` semantics, unlike the condition-priority fallback
            // above, which IS a same-target fallback).
            let best = map
                .iter()
                .filter(|(pattern, _)| pattern.contains('*'))
                .filter_map(|(pattern, value)| {
                    let pattern_rest = pattern.strip_prefix("./")?;
                    let prefix_len = pattern_rest.find('*').unwrap_or(pattern_rest.len());
                    match_wildcard(pattern_rest, rest)
                        .map(|captured| (prefix_len, pattern, captured, value))
                })
                .max_by(|left, right| left.0.cmp(&right.0).then(right.1.cmp(left.1)));
            if let Some((_, _, captured, value)) = best {
                let mut leaf_candidates = Vec::new();
                collect_condition_candidates(value, &mut leaf_candidates);
                candidates.extend(
                    leaf_candidates
                        .into_iter()
                        .map(|target| substitute_wildcard(&target, captured)),
                );
            }
        }
        _ => {}
    }
    candidates
}

#[derive(Debug, Clone, Default)]
struct PackageInfo {
    root: String,
    main: Option<String>,
    module: Option<String>,
    types: Option<String>,
    exports: Option<Value>,
}

impl PackageInfo {
    fn resolve(&self, subpath: Option<&str>, available: &BTreeSet<String>) -> Option<String> {
        if let Some(exports) = &self.exports {
            for target in resolve_exports_subpath(exports, subpath) {
                let candidate = join_subpath(&self.root, &target);
                if let Some(resolved) = probe_extensions(available, &candidate) {
                    return Some(resolved);
                }
            }
        }
        if subpath.is_some() {
            // A subpath specifier that `exports` did not resolve is never
            // allowed to fall through to `main`/`module`/`types` -- those
            // only ever name the package ROOT entry point.
            return None;
        }
        for target in [
            self.main.as_ref(),
            self.module.as_ref(),
            self.types.as_ref(),
        ]
        .into_iter()
        .flatten()
        {
            let candidate = join_subpath(&self.root, target);
            if let Some(resolved) = probe_extensions(available, &candidate) {
                return Some(resolved);
            }
        }
        None
    }

    /// P3-6 item 2: every extension-less BASE this package's resolution
    /// strategy (`exports`, then `main`/`module`/`types` for a bare
    /// specifier) could name for `subpath`, regardless of what's actually
    /// in `available` -- i.e. [`Self::resolve`]'s own candidate list
    /// without the `available.contains` short-circuit. A safe OVER-
    /// approximation is fine here (this only feeds a bounded-but-not-
    /// necessarily-minimal reverse index, never resolution itself): unlike
    /// `resolve`, this does not stop at `exports`' condition-priority
    /// order, and does not enforce the "subpath never falls back to
    /// main/module/types" rule -- both would only make the returned set
    /// SMALLER, and a smaller candidate set is the one thing a reverse
    /// index must never risk.
    fn candidate_bases(&self, subpath: Option<&str>) -> Vec<String> {
        let mut bases = Vec::new();
        if let Some(exports) = &self.exports {
            for target in resolve_exports_subpath(exports, subpath) {
                bases.push(join_subpath(&self.root, &target));
            }
        }
        for target in [
            self.main.as_ref(),
            self.module.as_ref(),
            self.types.as_ref(),
        ]
        .into_iter()
        .flatten()
        {
            bases.push(join_subpath(&self.root, target));
        }
        bases
    }
}

#[derive(Debug, Clone, Default)]
struct TsConfigResolved {
    dir: String,
    base_url_dir: Option<String>,
    paths: BTreeMap<String, Vec<String>>,
}

impl TsConfigResolved {
    fn resolve(&self, specifier: &str, available: &BTreeSet<String>) -> Option<String> {
        let base_dir = self.base_url_dir.as_deref().unwrap_or(&self.dir);
        let best_pattern = self
            .paths
            .iter()
            .filter_map(|(pattern, targets)| {
                let prefix_len = pattern.find('*').unwrap_or(pattern.len());
                match_wildcard(pattern, specifier).map(|captured| (prefix_len, captured, targets))
            })
            .max_by_key(|(prefix_len, _, _)| *prefix_len);
        if let Some((_, captured, targets)) = best_pattern {
            for target in targets {
                let substituted = substitute_wildcard(target, captured);
                let candidate = join_subpath(base_dir, &substituted);
                if let Some(resolved) = probe_extensions(available, &candidate) {
                    return Some(resolved);
                }
            }
            return None;
        }
        if self.base_url_dir.is_some() {
            let candidate = join_subpath(base_dir, specifier);
            return probe_extensions(available, &candidate);
        }
        None
    }

    /// P3-6 item 2: [`Self::resolve`]'s own candidate BASE(s) for
    /// `specifier`, without the `available.contains` short-circuit --
    /// same safe-over-approximation contract as `PackageInfo::
    /// candidate_bases`.
    fn candidate_bases(&self, specifier: &str) -> Vec<String> {
        let base_dir = self.base_url_dir.as_deref().unwrap_or(&self.dir);
        let best_pattern = self
            .paths
            .iter()
            .filter_map(|(pattern, targets)| {
                let prefix_len = pattern.find('*').unwrap_or(pattern.len());
                match_wildcard(pattern, specifier).map(|captured| (prefix_len, captured, targets))
            })
            .max_by_key(|(prefix_len, _, _)| *prefix_len);
        if let Some((_, captured, targets)) = best_pattern {
            return targets
                .iter()
                .map(|target| {
                    let substituted = substitute_wildcard(target, captured);
                    join_subpath(base_dir, &substituted)
                })
                .collect();
        }
        if self.base_url_dir.is_some() {
            return vec![join_subpath(base_dir, specifier)];
        }
        Vec::new()
    }
}

#[derive(Debug, Clone, Default)]
struct RawPackageJson {
    name: Option<String>,
    main: Option<String>,
    module: Option<String>,
    types: Option<String>,
    exports: Option<Value>,
    workspace_globs: Option<Vec<String>>,
}

fn parse_package_json(content: &str) -> Option<RawPackageJson> {
    let value: Value = serde_json::from_str(content).ok()?;
    let object = value.as_object()?;
    let string_field = |key: &str| object.get(key).and_then(Value::as_str).map(str::to_owned);
    let workspace_globs = match object.get("workspaces") {
        Some(Value::Array(entries)) => Some(
            entries
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect(),
        ),
        Some(Value::Object(map)) => map
            .get("packages")
            .and_then(Value::as_array)
            .map(|entries| {
                entries
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect()
            }),
        _ => None,
    };
    Some(RawPackageJson {
        name: string_field("name"),
        main: string_field("main"),
        module: string_field("module"),
        types: string_field("types").or_else(|| string_field("typings")),
        exports: object.get("exports").cloned(),
        workspace_globs,
    })
}

/// Minimal, dependency-free reader for the one YAML shape this corpus
/// actually needs: `pnpm-workspace.yaml`'s top-level `packages:` sequence of
/// single-quoted/double-quoted/bare glob strings. Deliberately not a general
/// YAML parser (no third-party YAML crate is in the dependency tree, and
/// adding one is out of scope for a narrow, single-key extraction).
fn parse_pnpm_workspace_packages(content: &str) -> Vec<String> {
    let mut globs = Vec::new();
    let mut lines = content.lines().peekable();
    while let Some(line) = lines.next() {
        let trimmed = line.trim_start();
        let indent = line.len() - trimmed.len();
        let Some(rest) = trimmed.strip_prefix("packages:") else {
            continue;
        };
        // Inline flow form: `packages: ['a', 'b']` (rare but valid YAML).
        let inline = rest.trim();
        if inline.starts_with('[') {
            let inner = inline.trim_start_matches('[').trim_end_matches(']');
            for item in inner.split(',') {
                let cleaned = unquote_yaml_scalar(item.trim());
                if !cleaned.is_empty() {
                    globs.push(cleaned);
                }
            }
            break;
        }
        // Block sequence form, one `- glob` per line, more indented than the
        // `packages:` key itself.
        while let Some(next) = lines.peek() {
            let next_trimmed = next.trim_start();
            let next_indent = next.len() - next_trimmed.len();
            if next_trimmed.is_empty() {
                lines.next();
                continue;
            }
            if next_indent <= indent || !next_trimmed.starts_with('-') {
                break;
            }
            let item = next_trimmed.trim_start_matches('-').trim();
            let cleaned = unquote_yaml_scalar(item);
            if !cleaned.is_empty() {
                globs.push(cleaned);
            }
            lines.next();
        }
        break;
    }
    globs
}

fn unquote_yaml_scalar(raw: &str) -> String {
    let value = raw.split('#').next().unwrap_or(raw).trim();
    let single = value.strip_prefix('\'').and_then(|v| v.strip_suffix('\''));
    let double = value.strip_prefix('"').and_then(|v| v.strip_suffix('"'));
    single.or(double).unwrap_or(value).to_owned()
}

/// A single glob segment matcher supporting `*` (any run of non-`/` chars)
/// and `**` (any run of chars, including `/`) -- the two forms
/// `pnpm-workspace.yaml`/`package.json#workspaces` globs actually use in
/// practice. A leading `!` negates the match (handled by the caller).
fn glob_matches(pattern: &str, candidate: &str) -> bool {
    fn recurse(pattern: &[u8], candidate: &[u8]) -> bool {
        match pattern.first() {
            None => candidate.is_empty(),
            Some(b'*') if pattern.get(1) == Some(&b'*') => {
                let rest = &pattern[2..];
                let rest = rest.strip_prefix(b"/").unwrap_or(rest);
                (0..=candidate.len()).any(|split| recurse(rest, &candidate[split..]))
            }
            Some(b'*') => {
                let rest = &pattern[1..];
                for split in 0..=candidate.len() {
                    if candidate[..split].contains(&b'/') {
                        break;
                    }
                    if recurse(rest, &candidate[split..]) {
                        return true;
                    }
                }
                false
            }
            Some(&byte) => {
                candidate.first() == Some(&byte) && recurse(&pattern[1..], &candidate[1..])
            }
        }
    }
    recurse(pattern.as_bytes(), candidate.as_bytes())
}

/// Strip JSON `//` and `/* */` comments (outside string literals) and
/// trailing commas before `}`/`]`, so a real `tsconfig.json`/`jsconfig.json`
/// -- which is JSONC, not strict JSON -- parses with `serde_json`. Not a
/// general JSON5 reader: only the two divergences tsconfig files actually
/// use in this corpus.
fn strip_jsonc(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let chars: Vec<char> = text.chars().collect();
    let mut i = 0usize;
    let mut in_string = false;
    let mut escaped = false;
    while i < chars.len() {
        let ch = chars[i];
        if in_string {
            out.push(ch);
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == '"' {
                in_string = false;
            }
            i += 1;
            continue;
        }
        match ch {
            '"' => {
                in_string = true;
                out.push(ch);
                i += 1;
            }
            '/' if chars.get(i + 1) == Some(&'/') => {
                while i < chars.len() && chars[i] != '\n' {
                    i += 1;
                }
            }
            '/' if chars.get(i + 1) == Some(&'*') => {
                i += 2;
                while i < chars.len() && !(chars[i] == '*' && chars.get(i + 1) == Some(&'/')) {
                    i += 1;
                }
                i += 2;
            }
            _ => {
                out.push(ch);
                i += 1;
            }
        }
    }
    strip_trailing_commas(&out)
}

fn strip_trailing_commas(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let chars: Vec<char> = text.chars().collect();
    let mut i = 0usize;
    while i < chars.len() {
        if chars[i] == ',' {
            let mut j = i + 1;
            while j < chars.len() && chars[j].is_whitespace() {
                j += 1;
            }
            if matches!(chars.get(j), Some('}') | Some(']')) {
                i += 1;
                continue;
            }
        }
        out.push(chars[i]);
        i += 1;
    }
    out
}

#[derive(Debug, Clone, Default)]
struct RawTsConfig {
    extends: Vec<String>,
    base_url: Option<String>,
    paths: Option<BTreeMap<String, Vec<String>>>,
}

fn parse_tsconfig(content: &str) -> Option<RawTsConfig> {
    let cleaned = strip_jsonc(content);
    let value: Value = serde_json::from_str(&cleaned).ok()?;
    let object = value.as_object()?;
    let extends = match object.get("extends") {
        Some(Value::String(single)) => vec![single.clone()],
        Some(Value::Array(entries)) => entries
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect(),
        _ => Vec::new(),
    };
    let compiler_options = object.get("compilerOptions").and_then(Value::as_object);
    let base_url = compiler_options
        .and_then(|options| options.get("baseUrl"))
        .and_then(Value::as_str)
        .map(str::to_owned);
    let paths = compiler_options
        .and_then(|options| options.get("paths"))
        .and_then(Value::as_object)
        .map(|map| {
            map.iter()
                .filter_map(|(pattern, targets)| {
                    let targets = targets
                        .as_array()?
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::to_owned)
                        .collect::<Vec<_>>();
                    Some((pattern.clone(), targets))
                })
                .collect()
        });
    Some(RawTsConfig {
        extends,
        base_url,
        paths,
    })
}

/// Workspace-aware resolver: everything `resolve_relative` could not do.
/// Constructed once per project generation (`analyze_config_assets` in
/// `lib.rs`) from whatever `ConfigAsset`s the caller captured; deliberately
/// stateless with respect to the JS/TS source set, which is passed in fresh
/// at each `resolve` call as `available` (mirrors `resolve_relative`'s own
/// signature, so a project with zero config assets behaves identically to
/// the pre-E2 resolver -- an empty `WorkspaceResolver` is a strict no-op
/// superset).
#[derive(Debug, Clone, Default)]
pub struct WorkspaceResolver {
    packages: BTreeMap<String, PackageInfo>,
    tsconfigs: BTreeMap<String, TsConfigResolved>,
}

impl WorkspaceResolver {
    pub fn build(assets: &[ConfigAsset]) -> Self {
        let mut sorted: Vec<&ConfigAsset> = assets.iter().collect();
        sorted.sort_by(|left, right| left.path.cmp(&right.path));

        let mut package_jsons: BTreeMap<String, RawPackageJson> = BTreeMap::new();
        let mut raw_tsconfigs: BTreeMap<String, RawTsConfig> = BTreeMap::new();
        let mut pnpm_globs: Option<Vec<String>> = None;
        for asset in &sorted {
            if asset.path == "pnpm-workspace.yaml" {
                pnpm_globs = Some(parse_pnpm_workspace_packages(&asset.content));
            } else if asset.path.ends_with("package.json")
                && let Some(parsed) = parse_package_json(&asset.content)
            {
                package_jsons.insert(asset.path.clone(), parsed);
            } else if (asset.path.ends_with("tsconfig.json")
                || asset.path.ends_with("jsconfig.json"))
                && let Some(parsed) = parse_tsconfig(&asset.content)
            {
                raw_tsconfigs.insert(asset.path.clone(), parsed);
            }
        }

        let mut globs = pnpm_globs.unwrap_or_default();
        if let Some(root) = package_jsons.get("package.json")
            && let Some(root_globs) = &root.workspace_globs
        {
            globs.extend(root_globs.iter().cloned());
        }
        let (positive_globs, negative_globs): (Vec<&str>, Vec<&str>) = globs
            .iter()
            .map(String::as_str)
            .partition(|glob| !glob.starts_with('!'));
        let negative_globs: Vec<&str> = negative_globs
            .into_iter()
            .map(|glob| glob.trim_start_matches('!'))
            .collect();

        let mut packages: BTreeMap<String, PackageInfo> = BTreeMap::new();
        for (path, manifest) in &package_jsons {
            let Some(name) = &manifest.name else {
                continue;
            };
            let dir = dirname(path);
            let is_root = dir.is_empty();
            let is_workspace_member = !globs.is_empty()
                && positive_globs.iter().any(|glob| glob_matches(glob, dir))
                && !negative_globs.iter().any(|glob| glob_matches(glob, dir));
            // The root package.json's own name is always eligible (a
            // single-package repo commonly self-references its own name);
            // every other package.json must match a positive workspace glob
            // to avoid resolving into a fixture/example directory that is
            // not actually a workspace member.
            if !is_root && !is_workspace_member {
                continue;
            }
            packages.entry(name.clone()).or_insert(PackageInfo {
                root: dir.to_owned(),
                main: manifest.main.clone(),
                module: manifest.module.clone(),
                types: manifest.types.clone(),
                exports: manifest.exports.clone(),
            });
        }

        let tsconfigs = resolve_tsconfigs(&raw_tsconfigs, &packages);

        Self {
            packages,
            tsconfigs,
        }
    }

    /// Resolve `specifier` written inside `from`. `.`-relative specifiers go
    /// straight to `resolve_relative` (identical to pre-E2 behavior); a bare
    /// specifier tries a matching workspace package first (an actual named
    /// package is a stronger signal than a `paths` alias), then the closest
    /// `tsconfig`/`jsconfig` `paths`/`baseUrl` mapping to `from`.
    pub fn resolve(
        &self,
        from: &str,
        specifier: &str,
        available: &BTreeSet<String>,
    ) -> Option<String> {
        if specifier.starts_with('.') {
            return resolve_relative(available, from, specifier);
        }
        if let Some((package_name, subpath)) = split_bare_specifier(specifier)
            && let Some(package) = self.packages.get(&package_name)
            && let Some(resolved) = package.resolve(subpath.as_deref(), available)
        {
            return Some(resolved);
        }
        self.nearest_tsconfig(from)
            .and_then(|config| config.resolve(specifier, available))
    }

    /// P3-6 item 2: every CONCRETE candidate path (extension/`/index`
    /// variants included) `specifier` (imported from `from`) could
    /// possibly resolve to under ANY of this resolver's strategies --
    /// relative, workspace-package, and tsconfig/jsconfig `paths`/
    /// `baseUrl` alike -- regardless of which one `resolve` would actually
    /// pick or what's currently in `available`. Deliberately a superset of
    /// what `resolve` itself would ever try in one call (it tries package
    /// resolution, and only falls back to tsconfig if THAT fails; this
    /// method always includes both): the only consumer is `lib.rs`'s
    /// reverse candidate-path index for bounded create/delete/rename
    /// re-resolution (P3-6 item 2), where a safe over-approximation just
    /// means a few extra (still cheap) `reresolve_file` calls, while an
    /// under-approximation would silently break the "identical to a full
    /// re-resolution" guarantee that index exists to preserve.
    pub fn candidate_paths(&self, from: &str, specifier: &str) -> Vec<String> {
        let mut bases = Vec::new();
        if specifier.starts_with('.') {
            bases.push(join_relative(dirname(from), specifier));
        } else {
            if let Some((package_name, subpath)) = split_bare_specifier(specifier)
                && let Some(package) = self.packages.get(&package_name)
            {
                bases.extend(package.candidate_bases(subpath.as_deref()));
            }
            if let Some(config) = self.nearest_tsconfig(from) {
                bases.extend(config.candidate_bases(specifier));
            }
        }
        let mut paths = Vec::with_capacity(bases.len() * (2 * RESOLUTION_EXTENSIONS.len() + 1));
        for base in &bases {
            push_candidate_variants(base, &mut paths);
        }
        paths
    }

    fn nearest_tsconfig(&self, from: &str) -> Option<&TsConfigResolved> {
        let mut dir = dirname(from);
        loop {
            let ts_path = if dir.is_empty() {
                "tsconfig.json".to_owned()
            } else {
                format!("{dir}/tsconfig.json")
            };
            if let Some(config) = self.tsconfigs.get(&ts_path) {
                return Some(config);
            }
            let js_path = if dir.is_empty() {
                "jsconfig.json".to_owned()
            } else {
                format!("{dir}/jsconfig.json")
            };
            if let Some(config) = self.tsconfigs.get(&js_path) {
                return Some(config);
            }
            if dir.is_empty() {
                return None;
            }
            dir = dirname(dir);
        }
    }
}

/// Resolve every raw tsconfig's `extends` chain into a flat, ready-to-query
/// `TsConfigResolved`. `extends` is walked from the config itself outward:
/// the nearest definition of `baseUrl`/`paths` wins in full (matching real
/// `tsc` semantics -- neither field is merged item-by-item across a chain).
fn resolve_tsconfigs(
    raw: &BTreeMap<String, RawTsConfig>,
    packages: &BTreeMap<String, PackageInfo>,
) -> BTreeMap<String, TsConfigResolved> {
    let mut resolved = BTreeMap::new();
    for path in raw.keys() {
        let mut visiting = BTreeSet::new();
        let (base_url_dir, paths) = resolve_extends_chain(path, raw, packages, &mut visiting, 0);
        resolved.insert(
            path.clone(),
            TsConfigResolved {
                dir: dirname(path).to_owned(),
                base_url_dir,
                paths: paths.unwrap_or_default(),
            },
        );
    }
    resolved
}

/// Returns `baseUrl` already resolved to an absolute (workspace-root-
/// relative) directory, NOT the raw JSON string -- real `tsc` resolves a
/// relative `baseUrl` against the directory of whichever config file
/// actually DEFINED it, not the directory of the file that `extends` it.
/// Resolving eagerly, at the point each file's own `base_url` is read,
/// keeps that fact correct as the value is carried up an `extends` chain
/// (an inherited `baseUrl` is already an absolute directory by the time a
/// child's own missing `baseUrl` falls back to it).
fn resolve_extends_chain(
    path: &str,
    raw: &BTreeMap<String, RawTsConfig>,
    packages: &BTreeMap<String, PackageInfo>,
    visiting: &mut BTreeSet<String>,
    depth: u8,
) -> (Option<String>, Option<BTreeMap<String, Vec<String>>>) {
    let Some(config) = raw.get(path) else {
        return (None, None);
    };
    let base_url_dir = config
        .base_url
        .as_ref()
        .map(|value| join_subpath(dirname(path), value));
    let paths = config.paths.clone();
    if base_url_dir.is_some() && paths.is_some() {
        return (base_url_dir, paths);
    }
    if depth >= MAX_EXTENDS_DEPTH || !visiting.insert(path.to_owned()) {
        return (base_url_dir, paths);
    }
    let mut inherited_base_url_dir = None;
    let mut inherited_paths = None;
    for extends in &config.extends {
        let Some(parent_path) = resolve_extends_target(path, extends, raw, packages) else {
            continue;
        };
        let (parent_base_url_dir, parent_paths) =
            resolve_extends_chain(&parent_path, raw, packages, visiting, depth + 1);
        if inherited_base_url_dir.is_none() {
            inherited_base_url_dir = parent_base_url_dir;
        }
        if inherited_paths.is_none() {
            inherited_paths = parent_paths;
        }
    }
    (
        base_url_dir.or(inherited_base_url_dir),
        paths.or(inherited_paths),
    )
}

/// Resolve an `extends` value to the tsconfig asset path it names: a
/// relative specifier (`./base`, `../shared/tsconfig.base`) probed with the
/// same `.json`/`/tsconfig.json` suffix rules `tsc` itself uses, or a
/// workspace-package-rooted one (`@scope/pkg/tsconfig.json`) resolved
/// through the same package map `resolve` uses (subpath joined directly to
/// the package root -- `extends` targets are not run through `exports`,
/// matching real `tsc` behavior, which reads `package.json#tsconfig` or a
/// literal path, never conditional exports).
fn resolve_extends_target(
    from_tsconfig: &str,
    extends: &str,
    raw: &BTreeMap<String, RawTsConfig>,
    packages: &BTreeMap<String, PackageInfo>,
) -> Option<String> {
    let candidates = |base: String| -> Vec<String> {
        vec![
            base.clone(),
            format!("{base}.json"),
            format!("{base}/tsconfig.json"),
        ]
    };
    let bases = if extends.starts_with('.') {
        vec![join_relative(dirname(from_tsconfig), extends)]
    } else {
        package_rooted_extends_bases(extends, packages).unwrap_or_default()
    };
    bases
        .into_iter()
        .flat_map(candidates)
        .find(|candidate| raw.contains_key(candidate))
}

fn package_rooted_extends_bases(
    extends: &str,
    packages: &BTreeMap<String, PackageInfo>,
) -> Option<Vec<String>> {
    let (package_name, subpath) = split_bare_specifier(extends)?;
    let package = packages.get(&package_name)?;
    Some(match subpath {
        Some(rest) => vec![join_subpath(&package.root, &rest)],
        None => vec![package.root.clone()],
    })
}

const MAX_EXPORT_RESOLUTION_DEPTH: u8 = 8;

/// Outcome of chasing an `import { name } from "specifier"` through
/// `WorkspaceResolver::resolve` and then this function: did it land on
/// exactly one declaration, is it genuinely ambiguous (multiple
/// declarations/re-exports could provide the name), or does the chain
/// simply not reach a provable answer (falls through to `checker_pending`
/// either way -- callers never distinguish `Ambiguous` from `Unresolved`,
/// the split exists purely so tests can assert *why* a case stays pending).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExportResolution {
    Resolved(String),
    /// P1-B: the chased name resolved to a namespace re-export (`export *
    /// as X from "spec"` -- see `crate::NAMESPACE_REEXPORT_LOCAL_NAME`'s
    /// doc comment) rather than a single declaration: `String` is the
    /// re-exported module's OWN resolved path, for the caller to look a
    /// FURTHER member name up against (`resolve_named_export` again, or
    /// the typeflow namespace-member rule) -- never itself a `target_id`.
    Namespace(String),
    Ambiguous,
    Unresolved,
}

/// Close an import -> export -> declaration chain (E2, F5 hybrid design):
/// given the project's full `files` map (already resolved by lane 1, so
/// every `DirectImport`/`SyntaxExportBinding` with a source specifier
/// already carries its `target_path`), find the single declaration
/// `name` resolves to when exported from `path`, following named
/// re-exports (`export { a } from "./x"`) transitively. Cycle-guarded and
/// depth-capped; `export *` is never attempted (see this module's doc
/// comment) -- a name only reachable through one always reports
/// `Unresolved`, never a guess.
pub fn resolve_named_export(
    files: &BTreeMap<String, SyntaxFileResult>,
    path: &str,
    name: &str,
) -> ExportResolution {
    let mut visiting = BTreeSet::new();
    resolve_named_export_inner(files, path, name, &mut visiting, 0)
}

fn resolve_named_export_inner(
    files: &BTreeMap<String, SyntaxFileResult>,
    path: &str,
    name: &str,
    visiting: &mut BTreeSet<(String, String)>,
    depth: u8,
) -> ExportResolution {
    if depth >= MAX_EXPORT_RESOLUTION_DEPTH || !visiting.insert((path.to_owned(), name.to_owned()))
    {
        return ExportResolution::Unresolved;
    }
    let Some(file) = files.get(path) else {
        return ExportResolution::Unresolved;
    };
    let matching: Vec<&SyntaxExportBinding> = file
        .export_bindings
        .iter()
        .filter(|binding| binding.exported_name == name)
        .collect();
    let (direct, reexport): (Vec<&SyntaxExportBinding>, Vec<&SyntaxExportBinding>) = matching
        .into_iter()
        .partition(|binding| binding.source_specifier.is_none());
    if !direct.is_empty() && !reexport.is_empty() {
        // Both a direct declaration and a re-export claim the same exported
        // name -- not valid, well-formed source, but never guess.
        return ExportResolution::Ambiguous;
    }
    if !direct.is_empty() {
        return resolve_direct_export(file, &direct);
    }
    match reexport.as_slice() {
        [] => ExportResolution::Unresolved,
        [binding] if binding.local_name == crate::NAMESPACE_REEXPORT_LOCAL_NAME => {
            // P1-B: `export * as X from "spec"` -- `X` names the WHOLE
            // re-exported module, never a single symbol to chase further
            // here (see `ExportResolution::Namespace`'s doc comment). A
            // deeper chain (`export * as X from "spec"` where `spec` ITSELF
            // does the same) is still handled transitively: the CALLER
            // re-invokes `resolve_named_export` against this same target
            // path for a further member name, which recurses into this
            // exact function again.
            match &binding.source_target_path {
                Some(target_path) => ExportResolution::Namespace(target_path.clone()),
                None => ExportResolution::Unresolved,
            }
        }
        [binding] => match &binding.source_target_path {
            Some(target_path) => resolve_named_export_inner(
                files,
                target_path,
                &binding.local_name,
                visiting,
                depth + 1,
            ),
            None => ExportResolution::Unresolved,
        },
        _ => ExportResolution::Ambiguous,
    }
}

fn resolve_direct_export(
    file: &SyntaxFileResult,
    direct: &[&SyntaxExportBinding],
) -> ExportResolution {
    let mut resolved_ids: BTreeSet<String> = BTreeSet::new();
    for binding in direct {
        let matches: Vec<&str> = file
            .entities
            .iter()
            .filter(|entity| entity.kind != EntityKind::Module && entity.name == binding.local_name)
            .map(|entity| entity.id.as_str())
            .collect();
        match matches.as_slice() {
            // Declared as exported but no (or an ambiguous) matching
            // top-level entity -- e.g. a namespace/`export =`/merged
            // declaration `SyntaxEntity` does not represent. Stay pending
            // rather than guess.
            [] => return ExportResolution::Unresolved,
            [single] => {
                resolved_ids.insert((*single).to_owned());
            }
            _ => return ExportResolution::Ambiguous,
        }
    }
    match resolved_ids.len() {
        1 => ExportResolution::Resolved(resolved_ids.into_iter().next().expect("checked len")),
        _ => ExportResolution::Ambiguous,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn asset(path: &str, content: &str) -> ConfigAsset {
        ConfigAsset {
            path: path.to_owned(),
            content: content.to_owned(),
        }
    }

    fn available(paths: &[&str]) -> BTreeSet<String> {
        paths.iter().map(|path| (*path).to_owned()).collect()
    }

    #[test]
    fn empty_resolver_matches_old_relative_behavior() {
        let resolver = WorkspaceResolver::default();
        let files = available(&["src/a.ts", "src/b/index.ts"]);
        assert_eq!(
            resolver.resolve("src/a.ts", "./b", &files),
            Some("src/b/index.ts".to_owned())
        );
        assert_eq!(resolver.resolve("src/a.ts", "left-pad", &files), None);
    }

    fn n8n_style_workspace() -> Vec<ConfigAsset> {
        vec![
            asset(
                "package.json",
                r#"{"name":"n8n-monorepo","workspaces":["packages/*"]}"#,
            ),
            asset(
                "packages/workflow/package.json",
                r#"{"name":"@n8n/workflow","main":"dist/index.js","types":"dist/index.d.ts"}"#,
            ),
            asset(
                "packages/core/package.json",
                r#"{
                    "name": "@n8n/core",
                    "exports": {
                        ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" },
                        "./package.json": "./package.json",
                        "./helpers/*": { "import": "./dist/helpers/*.js" }
                    }
                }"#,
            ),
            asset(
                "packages/fixtures/broken/package.json",
                r#"{"name":"@n8n/should-not-resolve","main":"dist/index.js"}"#,
            ),
        ]
    }

    #[test]
    fn resolves_bare_workspace_import_via_main_fallback() {
        let resolver = WorkspaceResolver::build(&n8n_style_workspace());
        let files = available(&["packages/workflow/dist/index.js", "packages/app/src/x.ts"]);
        assert_eq!(
            resolver.resolve("packages/app/src/x.ts", "@n8n/workflow", &files),
            Some("packages/workflow/dist/index.js".to_owned())
        );
    }

    #[test]
    fn resolves_bare_workspace_import_via_exports_root_condition_order() {
        let resolver = WorkspaceResolver::build(&n8n_style_workspace());
        let files = available(&["packages/core/dist/index.js", "packages/app/src/x.ts"]);
        assert_eq!(
            resolver.resolve("packages/app/src/x.ts", "@n8n/core", &files),
            Some("packages/core/dist/index.js".to_owned())
        );
    }

    #[test]
    fn resolves_workspace_export_subpath_wildcard() {
        let resolver = WorkspaceResolver::build(&n8n_style_workspace());
        let files = available(&["packages/core/dist/helpers/retry.js"]);
        assert_eq!(
            resolver.resolve("packages/app/src/x.ts", "@n8n/core/helpers/retry", &files),
            Some("packages/core/dist/helpers/retry.js".to_owned())
        );
    }

    #[test]
    fn non_workspace_member_package_json_is_not_a_resolution_target() {
        // Not covered by any `workspaces` glob (lives under `fixtures/`),
        // so its declared name must never resolve -- a stray package.json
        // in a test-fixture directory is exactly the false-positive this
        // guards against.
        let resolver = WorkspaceResolver::build(&n8n_style_workspace());
        let files = available(&["packages/fixtures/broken/dist/index.js"]);
        assert_eq!(
            resolver.resolve("packages/app/src/x.ts", "@n8n/should-not-resolve", &files),
            None
        );
    }

    #[test]
    fn exports_subpath_with_no_wildcard_match_and_no_main_stays_unresolved() {
        let resolver = WorkspaceResolver::build(&n8n_style_workspace());
        let files = available(&["packages/core/dist/index.js"]);
        assert_eq!(
            resolver.resolve("packages/app/src/x.ts", "@n8n/core/nope", &files),
            None
        );
    }

    #[test]
    fn tsconfig_paths_wildcard_resolves_relative_to_base_url() {
        let assets = vec![asset(
            "tsconfig.json",
            r#"{
                "compilerOptions": {
                    "baseUrl": ".",
                    "paths": { "@app/*": ["src/app/*"], "@app/root": ["src/app/root.ts"] }
                }
            }"#,
        )];
        let resolver = WorkspaceResolver::build(&assets);
        let files = available(&["src/app/widgets/button.ts", "src/consumer.ts"]);
        assert_eq!(
            resolver.resolve("src/consumer.ts", "@app/widgets/button", &files),
            Some("src/app/widgets/button.ts".to_owned())
        );
    }

    #[test]
    fn tsconfig_paths_exact_pattern_wins_over_wildcard() {
        let assets = vec![asset(
            "tsconfig.json",
            r#"{
                "compilerOptions": {
                    "baseUrl": ".",
                    "paths": { "@app/*": ["src/app/*"], "@app/root": ["src/app/special-root.ts"] }
                }
            }"#,
        )];
        let resolver = WorkspaceResolver::build(&assets);
        let files = available(&["src/app/root.ts", "src/app/special-root.ts"]);
        assert_eq!(
            resolver.resolve("src/consumer.ts", "@app/root", &files),
            Some("src/app/special-root.ts".to_owned())
        );
    }

    #[test]
    fn nearest_tsconfig_to_importer_wins_over_root() {
        let assets = vec![
            asset(
                "tsconfig.json",
                r#"{"compilerOptions": {"baseUrl": ".", "paths": {"@x": ["root-x.ts"]}}}"#,
            ),
            asset(
                "packages/app/tsconfig.json",
                r#"{"compilerOptions": {"baseUrl": ".", "paths": {"@x": ["nested-x.ts"]}}}"#,
            ),
        ];
        let resolver = WorkspaceResolver::build(&assets);
        let files = available(&["packages/app/nested-x.ts", "root-x.ts"]);
        assert_eq!(
            resolver.resolve("packages/app/src/consumer.ts", "@x", &files),
            Some("packages/app/nested-x.ts".to_owned())
        );
    }

    #[test]
    fn tsconfig_extends_relative_chain_inherits_paths() {
        // The base config is itself named `tsconfig.json` (a differently
        // named base file, e.g. `tsconfig.base.json`, is out of scope: T1
        // only ever captures assets literally named `tsconfig.json`/
        // `jsconfig.json` as a resolution asset).
        let assets = vec![
            asset(
                "shared/tsconfig.json",
                r#"{"compilerOptions": {"baseUrl": ".", "paths": {"@shared/*": ["*"]}}}"#,
            ),
            asset(
                "packages/app/tsconfig.json",
                r#"{"extends": "../../shared/tsconfig.json", "compilerOptions": {}}"#,
            ),
        ];
        let resolver = WorkspaceResolver::build(&assets);
        let files = available(&["shared/util.ts"]);
        assert_eq!(
            resolver.resolve("packages/app/src/consumer.ts", "@shared/util", &files),
            Some("shared/util.ts".to_owned())
        );
    }

    #[test]
    fn tsconfig_extends_own_paths_replace_rather_than_merge() {
        let assets = vec![
            asset(
                "tsconfig.base.json",
                r#"{"compilerOptions": {"baseUrl": ".", "paths": {"@shared/*": ["shared/*"]}}}"#,
            ),
            asset(
                "packages/app/tsconfig.json",
                r#"{
                    "extends": "../../tsconfig.base.json",
                    "compilerOptions": {"baseUrl": ".", "paths": {"@own/*": ["own/*"]}}
                }"#,
            ),
        ];
        let resolver = WorkspaceResolver::build(&assets);
        let files = available(&["packages/app/shared/util.ts", "packages/app/own/thing.ts"]);
        // The child's own `paths` fully replaces the inherited one: `@shared`
        // no longer resolves once `packages/app/tsconfig.json` declares its
        // own `paths` block.
        assert_eq!(
            resolver.resolve("packages/app/src/consumer.ts", "@shared/util", &files),
            None
        );
        assert_eq!(
            resolver.resolve("packages/app/src/consumer.ts", "@own/thing", &files),
            Some("packages/app/own/thing.ts".to_owned())
        );
    }

    #[test]
    fn tsconfig_extends_workspace_package_root() {
        let assets = vec![
            asset(
                "package.json",
                r#"{"name":"root","workspaces":["configs/*"]}"#,
            ),
            asset(
                "configs/ts-base/package.json",
                r#"{"name":"@internal/ts-base"}"#,
            ),
            asset(
                "configs/ts-base/tsconfig.json",
                r#"{"compilerOptions": {"baseUrl": ".", "paths": {"@base/*": ["base/*"]}}}"#,
            ),
            asset(
                "packages/app/tsconfig.json",
                r#"{"extends": "@internal/ts-base/tsconfig.json", "compilerOptions": {}}"#,
            ),
        ];
        let resolver = WorkspaceResolver::build(&assets);
        let files = available(&["configs/ts-base/base/thing.ts"]);
        assert_eq!(
            resolver.resolve("packages/app/src/consumer.ts", "@base/thing", &files),
            Some("configs/ts-base/base/thing.ts".to_owned())
        );
    }

    #[test]
    fn extends_cycle_does_not_hang() {
        let assets = vec![
            asset(
                "a.tsconfig.json",
                r#"{"extends": "./b.tsconfig.json", "compilerOptions": {}}"#,
            ),
            asset(
                "b.tsconfig.json",
                r#"{"extends": "./a.tsconfig.json", "compilerOptions": {}}"#,
            ),
            asset(
                "tsconfig.json",
                r#"{"extends": "./a.tsconfig.json", "compilerOptions": {}}"#,
            ),
        ];
        let resolver = WorkspaceResolver::build(&assets);
        let files = available(&["x.ts"]);
        assert_eq!(resolver.resolve("consumer.ts", "@x", &files), None);
    }

    #[test]
    fn pnpm_workspace_yaml_packages_glob_gates_membership() {
        let assets = vec![
            asset("pnpm-workspace.yaml", "packages:\n  - 'packages/*'\n"),
            asset(
                "packages/workflow/package.json",
                r#"{"name":"@n8n/workflow","main":"dist/index.js"}"#,
            ),
            asset(
                "examples/demo/package.json",
                r#"{"name":"@n8n/demo-not-a-member","main":"dist/index.js"}"#,
            ),
        ];
        let resolver = WorkspaceResolver::build(&assets);
        let files = available(&[
            "packages/workflow/dist/index.js",
            "examples/demo/dist/index.js",
        ]);
        assert_eq!(
            resolver.resolve("x.ts", "@n8n/workflow", &files),
            Some("packages/workflow/dist/index.js".to_owned())
        );
        assert_eq!(
            resolver.resolve("x.ts", "@n8n/demo-not-a-member", &files),
            None
        );
    }

    #[test]
    fn pnpm_workspace_yaml_negation_excludes_matching_dir() {
        let assets = vec![
            asset(
                "pnpm-workspace.yaml",
                "packages:\n  - 'packages/*'\n  - '!packages/excluded'\n",
            ),
            asset(
                "packages/excluded/package.json",
                r#"{"name":"@n8n/excluded","main":"dist/index.js"}"#,
            ),
        ];
        let resolver = WorkspaceResolver::build(&assets);
        let files = available(&["packages/excluded/dist/index.js"]);
        assert_eq!(resolver.resolve("x.ts", "@n8n/excluded", &files), None);
    }

    #[test]
    fn strip_jsonc_handles_comments_and_trailing_commas() {
        let content = r#"{
            // a line comment
            "compilerOptions": {
                "baseUrl": ".", /* inline */
                "paths": { "@x": ["x.ts"], },
            },
        }"#;
        let parsed = parse_tsconfig(content).expect("jsonc parses");
        assert_eq!(parsed.base_url.as_deref(), Some("."));
        assert!(parsed.paths.is_some());
    }

    #[test]
    fn glob_matches_star_and_double_star() {
        assert!(glob_matches("packages/*", "packages/foo"));
        assert!(!glob_matches("packages/*", "packages/foo/bar"));
        assert!(glob_matches("packages/**", "packages/foo/bar"));
        assert!(glob_matches("**", "anything/at/all"));
        assert!(!glob_matches("packages/*", "other/foo"));
    }

    fn entity(kind: EntityKind, path: &str, start: u32, name: &str) -> crate::SyntaxEntity {
        crate::SyntaxEntity {
            id: format!("jsts:{}:{path}:{start}:{name}", entity_kind_name(kind)),
            name: name.to_owned(),
            kind,
            universal_kind: crate::UniversalKind::Value,
            path: path.to_owned(),
            start,
            end: start + name.len() as u32,
            parent_id: None,
            qualified_name: None,
            is_test: None,
        }
    }

    fn entity_kind_name(kind: EntityKind) -> &'static str {
        match kind {
            EntityKind::Module => "module",
            EntityKind::Function => "function",
            EntityKind::Class => "class",
            EntityKind::Interface => "interface",
            EntityKind::Type => "type",
            EntityKind::Enum => "enum",
            EntityKind::Variable => "variable",
        }
    }

    fn binding(
        exported_name: &str,
        local_name: &str,
        source_specifier: Option<&str>,
        source_target_path: Option<&str>,
    ) -> SyntaxExportBinding {
        SyntaxExportBinding {
            exported_name: exported_name.to_owned(),
            local_name: local_name.to_owned(),
            source_specifier: source_specifier.map(str::to_owned),
            source_target_path: source_target_path.map(str::to_owned),
        }
    }

    fn file(
        path: &str,
        entities: Vec<crate::SyntaxEntity>,
        export_bindings: Vec<SyntaxExportBinding>,
    ) -> SyntaxFileResult {
        SyntaxFileResult {
            path: path.to_owned(),
            content_digest: "sha256:0".to_owned(),
            language: crate::Language::Typescript,
            script_kind: crate::ScriptKind::Ts,
            byte_length: 0,
            parsed: true,
            direct_imports: Vec::new(),
            entities,
            relations: Vec::new(),
            diagnostics: Vec::new(),
            export_bindings,
        }
    }

    #[test]
    fn resolve_named_export_direct_declaration() {
        let mut files = BTreeMap::new();
        files.insert(
            "src/util.ts".to_owned(),
            file(
                "src/util.ts",
                vec![entity(EntityKind::Function, "src/util.ts", 20, "helper")],
                vec![binding("helper", "helper", None, None)],
            ),
        );
        assert_eq!(
            resolve_named_export(&files, "src/util.ts", "helper"),
            ExportResolution::Resolved("jsts:function:src/util.ts:20:helper".to_owned())
        );
    }

    #[test]
    fn resolve_named_export_follows_one_hop_reexport() {
        let mut files = BTreeMap::new();
        files.insert(
            "src/impl.ts".to_owned(),
            file(
                "src/impl.ts",
                vec![entity(EntityKind::Class, "src/impl.ts", 10, "Widget")],
                vec![binding("Widget", "Widget", None, None)],
            ),
        );
        files.insert(
            "src/index.ts".to_owned(),
            file(
                "src/index.ts",
                vec![],
                vec![binding(
                    "Widget",
                    "Widget",
                    Some("./impl"),
                    Some("src/impl.ts"),
                )],
            ),
        );
        assert_eq!(
            resolve_named_export(&files, "src/index.ts", "Widget"),
            ExportResolution::Resolved("jsts:class:src/impl.ts:10:Widget".to_owned())
        );
    }

    #[test]
    fn resolve_named_export_ambiguous_on_duplicate_declaration() {
        let mut files = BTreeMap::new();
        files.insert(
            "src/overloads.ts".to_owned(),
            file(
                "src/overloads.ts",
                vec![
                    entity(EntityKind::Function, "src/overloads.ts", 10, "f"),
                    entity(EntityKind::Function, "src/overloads.ts", 40, "f"),
                ],
                vec![binding("f", "f", None, None)],
            ),
        );
        assert_eq!(
            resolve_named_export(&files, "src/overloads.ts", "f"),
            ExportResolution::Ambiguous
        );
    }

    #[test]
    fn resolve_named_export_unresolved_when_only_star_reexported() {
        // `export * from "./impl"` never contributes an `export_bindings`
        // entry (by design), so a name only reachable that way must stay
        // Unresolved -- never guessed.
        let mut files = BTreeMap::new();
        files.insert(
            "src/impl.ts".to_owned(),
            file(
                "src/impl.ts",
                vec![entity(EntityKind::Function, "src/impl.ts", 10, "helper")],
                vec![binding("helper", "helper", None, None)],
            ),
        );
        files.insert(
            "src/index.ts".to_owned(),
            file("src/index.ts", vec![], vec![]),
        );
        assert_eq!(
            resolve_named_export(&files, "src/index.ts", "helper"),
            ExportResolution::Unresolved
        );
    }

    #[test]
    fn resolve_named_export_reexport_cycle_terminates() {
        let mut files = BTreeMap::new();
        files.insert(
            "a.ts".to_owned(),
            file(
                "a.ts",
                vec![],
                vec![binding("x", "x", Some("./b"), Some("b.ts"))],
            ),
        );
        files.insert(
            "b.ts".to_owned(),
            file(
                "b.ts",
                vec![],
                vec![binding("x", "x", Some("./a"), Some("a.ts"))],
            ),
        );
        assert_eq!(
            resolve_named_export(&files, "a.ts", "x"),
            ExportResolution::Unresolved
        );
    }

    #[test]
    fn resolve_named_export_namespace_reexport() {
        // `export * as evals from "./evals/index"` -- see
        // `crate::NAMESPACE_REEXPORT_LOCAL_NAME`'s doc comment.
        let mut files = BTreeMap::new();
        files.insert(
            "evals/index.ts".to_owned(),
            file(
                "evals/index.ts",
                vec![entity(
                    EntityKind::Function,
                    "evals/index.ts",
                    899,
                    "stringSimilarity",
                )],
                vec![binding("stringSimilarity", "stringSimilarity", None, None)],
            ),
        );
        files.insert(
            "index.ts".to_owned(),
            file(
                "index.ts",
                vec![],
                vec![binding(
                    "evals",
                    crate::NAMESPACE_REEXPORT_LOCAL_NAME,
                    Some("./evals/index"),
                    Some("evals/index.ts"),
                )],
            ),
        );
        assert_eq!(
            resolve_named_export(&files, "index.ts", "evals"),
            ExportResolution::Namespace("evals/index.ts".to_owned())
        );
        // The whole point: a FURTHER member name resolves against the
        // re-exported module directly.
        assert_eq!(
            resolve_named_export(&files, "evals/index.ts", "stringSimilarity"),
            ExportResolution::Resolved(
                "jsts:function:evals/index.ts:899:stringSimilarity".to_owned()
            )
        );
    }

    #[test]
    fn resolve_named_export_namespace_reexport_chains_transitively() {
        // `export * as evals from "./mid"` where `./mid` ITSELF does
        // `export * as evals from "./leaf"` -- the outer namespace's own
        // resolution recurses into the inner one automatically (the
        // CALLER re-invokes `resolve_named_export` against the first
        // hop's target path, which lands on the SAME sentinel-checking
        // branch again).
        let mut files = BTreeMap::new();
        files.insert(
            "leaf.ts".to_owned(),
            file(
                "leaf.ts",
                vec![entity(EntityKind::Function, "leaf.ts", 5, "f")],
                vec![binding("f", "f", None, None)],
            ),
        );
        files.insert(
            "mid.ts".to_owned(),
            file(
                "mid.ts",
                vec![],
                vec![binding(
                    "evals",
                    crate::NAMESPACE_REEXPORT_LOCAL_NAME,
                    Some("./leaf"),
                    Some("leaf.ts"),
                )],
            ),
        );
        assert_eq!(
            resolve_named_export(&files, "mid.ts", "evals"),
            ExportResolution::Namespace("leaf.ts".to_owned())
        );
    }

    #[test]
    fn scoped_bare_specifier_splits_name_and_subpath() {
        assert_eq!(
            split_bare_specifier("@n8n/core/helpers/retry"),
            Some(("@n8n/core".to_owned(), Some("helpers/retry".to_owned())))
        );
        assert_eq!(
            split_bare_specifier("lodash"),
            Some(("lodash".to_owned(), None))
        );
        assert_eq!(split_bare_specifier("./relative"), None);
    }
}
