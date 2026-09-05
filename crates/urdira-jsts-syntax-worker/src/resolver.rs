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

use crate::{
    AmbientModuleDeclaration, AmbientModuleMember, EntityKind, SyntaxEntity, SyntaxExportBinding,
    SyntaxFileResult,
};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet, HashMap};

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
/// 3a (2026-09-05): which rule [`resolve_direct_export`] applies when a
/// direct declaration's `local_name` matches MORE THAN ONE same-named
/// top-level entity (the overload/merge case -- see that function's own
/// doc comment for the full mechanism and why it is now split by caller
/// intent instead of always degrading to `Ambiguous`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExportPolicy {
    /// The pre-existing, always-safe rule: more than one same-named
    /// candidate is `Ambiguous`, unconditionally. Required for a CALL
    /// target (`resolve_identifier_to_kind`/`resolve_call_target`'s own
    /// callers) -- picking a specific overload signature by source order
    /// alone is never validated against v3's real argument-type-based
    /// overload resolution, so a wrong guess here would fabricate a wrong
    /// `core:call` edge.
    UniqueOrAmbiguous,
    /// Several same-named candidates that are ALL a legitimate overload
    /// shape (every one `EntityKind::Function` or every one
    /// `EntityKind::Method` -- never a mix, and never any other kind)
    /// resolve to the one with the lowest `decl_start` (source order) --
    /// v3's own checker behavior for a PLAIN reference, 11/11 sampled
    /// clusters (see `resolve_direct_export`'s own doc comment). A kind
    /// mismatch across candidates (e.g. a `const X` plus a `namespace X`
    /// declaration merge) is not a real overload set and stays `Ambiguous`
    /// under this policy too -- never a guess.
    FirstDeclaration,
}

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
/// every `DirectImport`/`SyntaxExportBinding`/`ExportStarSpecifier` with a
/// source specifier already carries its `target_path`), find the single
/// declaration `name` resolves to when exported from `path`, following
/// named re-exports (`export { a } from "./x"`, transitively -- already
/// bounded/cycle-guarded before this task) AND, since the 2026-09-04
/// references-parity task (bucket 2), bare `export * from "./x"` barrels
/// (`ExportStarSpecifier`, tried ONLY when `name` matches no direct
/// declaration and no named re-export in `path` itself -- see `resolve_
/// named_export_inner`'s own body). A star barrel never guesses: `name` is
/// resolved through EVERY one of `path`'s own `export_star_specifiers`
/// targets, and the result is only ever `Resolved`/`Namespace`/`Ambiguous`
/// when EXACTLY ONE of those targets provides `name` at all (mirroring real
/// ESM's own "ambiguous export" restriction for two `export *` sources
/// providing the same name) -- two or more providing candidates, or a
/// candidate that is itself ambiguous, degrade to `Unresolved` rather than
/// pick one. Cycle-guarded and depth-capped (`MAX_EXPORT_RESOLUTION_DEPTH`,
/// shared across the named-reexport and star-barrel chains alike, via the
/// same `visiting`/`depth` threaded through every recursive call).
pub fn resolve_named_export(
    files: &BTreeMap<String, SyntaxFileResult>,
    path: &str,
    name: &str,
    policy: ExportPolicy,
) -> ExportResolution {
    let mut visiting = BTreeSet::new();
    resolve_named_export_inner(files, path, name, policy, &mut visiting, 0)
}

fn resolve_named_export_inner(
    files: &BTreeMap<String, SyntaxFileResult>,
    path: &str,
    name: &str,
    policy: ExportPolicy,
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
        return resolve_direct_export(file, &direct, policy);
    }
    match reexport.as_slice() {
        [] => resolve_via_export_star(files, file, name, policy, visiting, depth),
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
                policy,
                visiting,
                depth + 1,
            ),
            None => ExportResolution::Unresolved,
        },
        _ => ExportResolution::Ambiguous,
    }
}

/// 2026-09-04 references-parity task, bucket 2: `name` matched no direct
/// declaration and no named re-export in `file` itself -- the LAST chance is
/// one of `file`'s own bare `export * from "./x"` barrels re-exporting it.
/// Tries `name` against EVERY star target (each a fresh, independent
/// `resolve_named_export_inner` call sharing the SAME `visiting`/`depth`
/// cycle guard as the caller, so a star cycle -- `a.ts` doing `export * from
/// "./b"` while `b.ts` does `export * from "./a"` -- terminates exactly like
/// a named-reexport cycle already does), and only trusts the result when
/// EXACTLY ONE target actually provides `name` (a non-`Unresolved` outcome).
/// Zero providing targets stays `Unresolved`; two or more (even if some
/// individually resolve to the SAME declaration through separate paths, or
/// one is itself only `Ambiguous`) degrade to `Ambiguous` -- never a guess
/// at which star source "wins", matching real ESM's own restriction against
/// two `export *` sources providing the same name.
fn resolve_via_export_star(
    files: &BTreeMap<String, SyntaxFileResult>,
    file: &SyntaxFileResult,
    name: &str,
    policy: ExportPolicy,
    visiting: &mut BTreeSet<(String, String)>,
    depth: u8,
) -> ExportResolution {
    let mut providing: Vec<ExportResolution> = Vec::new();
    for star in &file.export_star_specifiers {
        let Some(target_path) = &star.target_path else {
            continue;
        };
        let outcome =
            resolve_named_export_inner(files, target_path, name, policy, visiting, depth + 1);
        if outcome != ExportResolution::Unresolved {
            providing.push(outcome);
        }
    }
    match providing.len() {
        0 => ExportResolution::Unresolved,
        1 => providing.into_iter().next().expect("checked len"),
        _ => ExportResolution::Ambiguous,
    }
}

/// A5b (2026-09-05 references-parity task, overload sub-bucket), IMPLEMENTED
/// by 3a (2026-09-05) -- see [`ExportPolicy`] for the mechanism actually
/// shipped and this doc comment's tail for the measurement that motivated
/// it: TS function overloads
/// (`function f(...): T; function f(...): T; function f(...) { ... }`) each
/// get their OWN `SyntaxEntity` (one per `visit_function` call, since every
/// overload SIGNATURE, a bodyless `TSDeclareFunction`, and the trailing
/// IMPLEMENTATION are separate AST nodes), while `export_bindings`' own
/// post-collection `sort()`/`dedup()` (lib.rs's `parse_source`) collapses the
/// identical `export function f` binding they each independently push down
/// to ONE -- so a genuinely overloaded exported function reaches here as a
/// SINGLE `binding` against MULTIPLE same-named entities, and this function
/// degraded that to `Ambiguous` unconditionally before 3a (the `_ =>
/// Ambiguous` arm below). Sampled every `import_binding/export:ambiguous`
/// site (600 reservoir-sampled, `--samples 600` on `scripts/v4-references-
/// parity-diff.mjs`) down to its unique `(declaring file, name)` cluster (16
/// unique clusters) and checked, for the 11 clusters that actually had >1
/// same-file same-name `EntityKind::Function` entity (`createFilesystem`,
/// `Service`, `mockSpawn`, `isCanvasGroupNode`, `validateFieldType`,
/// `sanitizeCredentials`, `clean`, `attempt`, `randomInt`, `randomString`,
/// `continueInstanceAiTraceContext` -- 2-3 overloads each), which declaration
/// v3's checker resolved a plain (non-call) reference to: the FIRST
/// declaration in source order (lowest `start`) -- 11/11, unanimous, NEVER
/// the implementation (highest `start`, the intuitive guess this task
/// started from).
///
/// A5b originally left this unimplemented: `resolve_direct_export` is the
/// SAME function `resolve_named_export` uses for every caller, and in
/// `semantic_sites.rs` its result was cached ONCE per imported symbol
/// (`HybridResolutionContext::import_bindings`, keyed by `SymbolId`) and
/// consumed identically by a plain identifier reference
/// (`resolve_identifier_reference`) AND a call's callee
/// (`resolve_identifier_to_kind`, `resolve_call_target`'s own doc comment
/// explicitly documented `resolve_direct_export`-is-`Ambiguous` as why an
/// overloaded callee stays `REASON_CALL_TARGET_UNCERTAIN` rather than a
/// guessed target). Prototyping a blanket first-declaration rule here made
/// `semantic_sites::tests::ambiguous_multiple_declarations_in_target_stays_
/// pending` (a PLAIN REFERENCE assertion, same shape as this task's own
/// oracle sample) and `semantic_sites::tests::cross_file_call_target_
/// ambiguous_in_the_target_module_stays_pending` both fail: the call site
/// resolved to a specific overload signature chosen purely by SOURCE ORDER,
/// never validated against v3's ACTUAL call-site overload resolution (which
/// picks a signature by ARGUMENT-TYPE matching, not declaration order, and
/// could legitimately differ per call site) -- a real risk of introducing
/// new WRONG `core:call` targets A5b never measured.
///
/// 3a's fix: [`ExportPolicy`] gives `resolve_direct_export` two rules
/// instead of one, and `semantic_sites.rs` now threads caller intent all
/// the way from `resolve_named_binding_via_specifier` down to here, exactly
/// the mechanism A5b's own doc comment named as missing --
/// `HybridResolutionContext::import_bindings` is split into `import_
/// bindings_ref` (`ExportPolicy::FirstDeclaration`, read by `resolve_
/// identifier_reference`) and `import_bindings_call`
/// (`ExportPolicy::UniqueOrAmbiguous`, read by `resolve_identifier_to_kind`/
/// `resolve_call_target`), populated together at each of the three import-
/// specifier sites. The call side stays exactly as conservative as before
/// (still `REASON_CALL_TARGET_UNCERTAIN`, still no argument-type
/// validation) -- 3a does not attempt overload-by-argument resolution at
/// all, only the plain-reference side A5b's own sample was unanimous about.
fn resolve_direct_export(
    file: &SyntaxFileResult,
    direct: &[&SyntaxExportBinding],
    policy: ExportPolicy,
) -> ExportResolution {
    let mut resolved_ids: BTreeSet<String> = BTreeSet::new();
    for binding in direct {
        let matches: Vec<&SyntaxEntity> = file
            .entities
            .iter()
            .filter(|entity| entity.kind != EntityKind::Module && entity.name == binding.local_name)
            .collect();
        match matches.as_slice() {
            // Declared as exported but no (or an ambiguous) matching
            // top-level entity -- e.g. a namespace/`export =`/merged
            // declaration `SyntaxEntity` does not represent. Stay pending
            // rather than guess.
            [] => return ExportResolution::Unresolved,
            [single] => {
                resolved_ids.insert(single.id.clone());
            }
            several => {
                // 3a: several same-named candidates -- a real overload set
                // (every candidate the SAME `EntityKind::Function` or the
                // same `EntityKind::Method`) resolves to the earliest
                // declaration under `FirstDeclaration`; anything else (a
                // kind mismatch, or `UniqueOrAmbiguous`) stays `Ambiguous`,
                // never a guess.
                let first_kind = several[0].kind;
                let is_overload_shape =
                    matches!(first_kind, EntityKind::Function | EntityKind::Method)
                        && several.iter().all(|entity| entity.kind == first_kind);
                if policy == ExportPolicy::FirstDeclaration && is_overload_shape {
                    let first = several
                        .iter()
                        .min_by_key(|entity| entity.start)
                        .expect("several is non-empty");
                    resolved_ids.insert(first.id.clone());
                } else {
                    return ExportResolution::Ambiguous;
                }
            }
        }
    }
    match resolved_ids.len() {
        1 => ExportResolution::Resolved(resolved_ids.into_iter().next().expect("checked len")),
        _ => ExportResolution::Ambiguous,
    }
}

/// Ambient module resolution task (2026-09-04): the workspace-wide index of
/// every `declare module "specifier" { ... }` block any file declares,
/// keyed by `specifier` -- built fresh from the project's current `files`
/// map (see `SyntaxWorkerState::analyze`'s own doc comment for why this is
/// deliberately NOT incrementally maintained: ambient declarations are rare
/// enough that a full rebuild is cheap). Consulted at TWO different
/// granularities: `unique_namespace_entity`/`has_any_declaration` for the
/// MODULE-EDGE level (`lib.rs`'s `jsts:relation_import`/`export` target,
/// which only cares "does exactly one file declare this specifier", never
/// which name is imported), and `resolve_export` for the NAME level
/// (`semantic_sites.rs`'s reference resolution, which also needs to know
/// which declaration a specific imported name/default/namespace-value
/// resolves to inside that one declaring file's block).
///
/// **Wildcard patterns** (found live against the n8n corpus: `declare
/// module '~icons/*' { ... }`, a common virtual-asset-module convention --
/// TypeScript's own ambient module wildcard syntax, ONE `*` standing for
/// any run of characters, slashes included, e.g. `~icons/*` matches
/// `~icons/lucide/message-square`): a declared specifier containing
/// exactly one `*` is indexed SEPARATELY (`patterns`, never mixed into
/// `by_specifier`'s exact-match map) and consulted only after an exact
/// match misses. When several patterns match the same lookup specifier,
/// TypeScript itself picks the one with the LONGEST prefix before the `*`
/// (the identical precedence rule `tsconfig.json`'s own `compilerOptions.
/// paths` wildcard resolution uses) -- mirrored by `matching_patterns`
/// below; a genuine tie (two patterns with an equally long prefix) is
/// workspace-ambiguous, same "never guess" treatment as two files
/// declaring the identical literal specifier.
#[derive(Debug, Default)]
pub struct AmbientModuleIndex {
    by_specifier: HashMap<String, Vec<(String, AmbientModuleDeclaration)>>,
    /// `(pattern_specifier, declaring_path, declaration)` -- every declared
    /// specifier containing EXACTLY one `*`. A pattern with zero or more
    /// than one `*` is not TypeScript's wildcard syntax at all (TS only
    /// ever recognizes a SINGLE `*`); such a specifier is only ever reached
    /// through `by_specifier`'s literal-text match, same as before this
    /// wildcard support existed.
    patterns: Vec<(String, String, AmbientModuleDeclaration)>,
}

impl AmbientModuleIndex {
    /// Owner-flagged follow-up (2026-09-04): a `declare module` block whose
    /// OWN FILE has top-level `import`/`export` syntax is a MODULE
    /// AUGMENTATION (`AmbientModuleDeclaration::is_augmentation`), not a
    /// genuine ambient module declaration -- it EXTENDS an existing
    /// external package's type surface (e.g. `declare module "vue" {
    /// interface ComponentCustomProperties {...} }`) and must never enter
    /// this index (skipped entirely, both from the exact-match map and
    /// from `patterns` -- "ignored for resolution", not merely
    /// deprioritized). Set `URDIRA_V4_DEBUG_AMBIENT_MODULES=1` to print how
    /// many of each this call saw, split further by exact-vs-wildcard
    /// specifier shape.
    pub fn rebuild(files: &BTreeMap<String, SyntaxFileResult>) -> Self {
        let mut by_specifier: HashMap<String, Vec<(String, AmbientModuleDeclaration)>> =
            HashMap::new();
        let mut patterns: Vec<(String, String, AmbientModuleDeclaration)> = Vec::new();
        let mut script_count = 0u64;
        let mut augmentation_count = 0u64;
        for (path, file) in files {
            for declaration in &file.ambient_modules {
                if declaration.is_augmentation {
                    augmentation_count += 1;
                    continue;
                }
                script_count += 1;
                if declaration.specifier.matches('*').count() == 1 {
                    patterns.push((
                        declaration.specifier.clone(),
                        path.clone(),
                        declaration.clone(),
                    ));
                }
                by_specifier
                    .entry(declaration.specifier.clone())
                    .or_default()
                    .push((path.clone(), declaration.clone()));
            }
        }
        if std::env::var_os("URDIRA_V4_DEBUG_AMBIENT_MODULES").is_some() {
            eprintln!(
                "[AmbientModuleIndex::rebuild] script_declarations={script_count} (exact_specifiers={} wildcard_specifiers={}) module_augmentations_ignored={augmentation_count}",
                by_specifier.len(),
                patterns.len(),
            );
        }
        Self {
            by_specifier,
            patterns,
        }
    }

    /// Every `(declaring_path, declaration)` a lookup `specifier` resolves
    /// to: an EXACT `by_specifier` match when one exists (a literal
    /// specifier always wins over a wildcard pattern, matching TypeScript's
    /// own precedence), otherwise every `patterns` entry whose prefix/
    /// suffix match `specifier` AND whose prefix is the LONGEST among all
    /// matching patterns (TS's own tie-break rule) -- more than one pattern
    /// tied at that same longest prefix length is returned as multiple
    /// entries too, so every caller's existing "more than one declaration"
    /// ambiguity handling covers this case for free, no separate branch
    /// needed.
    fn declarations_for(&self, specifier: &str) -> Vec<(&str, &AmbientModuleDeclaration)> {
        if let Some(exact) = self.by_specifier.get(specifier)
            && !exact.is_empty()
        {
            return exact
                .iter()
                .map(|(path, declaration)| (path.as_str(), declaration))
                .collect();
        }
        let mut best_prefix_len: Option<usize> = None;
        let mut matches: Vec<(&str, &AmbientModuleDeclaration)> = Vec::new();
        for (pattern, path, declaration) in &self.patterns {
            let Some(prefix_len) = wildcard_prefix_match(pattern, specifier) else {
                continue;
            };
            match best_prefix_len {
                Some(best) if prefix_len < best => continue,
                Some(best) if prefix_len > best => {
                    best_prefix_len = Some(prefix_len);
                    matches.clear();
                }
                _ => {
                    best_prefix_len = Some(prefix_len);
                }
            }
            matches.push((path.as_str(), declaration));
        }
        matches
    }

    /// The MODULE-EDGE target for a bare specifier's `jsts:relation_
    /// import`/`export` row (fix item 2): `Some(id)` only when EXACTLY ONE
    /// workspace file declares `declare module "specifier"` -- regardless
    /// of whether that block is bodyful or the bodyless shorthand (a
    /// module-to-module EDGE targets the block itself either way; it is
    /// only NAME-level resolution, `resolve_export` below, that treats a
    /// shorthand block as never providing a nameable declaration). Two or
    /// more declaring files is workspace-ambiguous -- `None`, same as zero
    /// (the caller distinguishes the two via `has_any_declaration`).
    pub fn unique_namespace_entity(&self, specifier: &str) -> Option<String> {
        match self.declarations_for(specifier).as_slice() {
            [(_, declaration)] => Some(declaration.namespace_entity_id.clone()),
            _ => None,
        }
    }

    /// Whether ANY workspace file declares `declare module "specifier"`
    /// (a literal match, or the longest-prefix wildcard match(es) --
    /// `declarations_for`'s own doc comment) -- distinguishes "workspace-
    /// ambiguous, several declaring files" (stay `Possible`/pending, never
    /// external) from "no ambient declaration at all" (fall through to
    /// `classify_external_specifier`).
    pub fn has_any_declaration(&self, specifier: &str) -> bool {
        !self.declarations_for(specifier).is_empty()
    }

    /// NAME-level resolution (fix items 2-3): what does `name` (an ordinary
    /// imported name, `"default"` for a default import, or `"*"` for a
    /// namespace import's own binding used as a value) resolve to when
    /// imported from `specifier`? See the module doc comment for the exact
    /// contract; the short version is "resolve with certainty, or stay
    /// pending -- NEVER fall through to an external entity once `specifier`
    /// is known to be ambiently declared somewhere in this workspace".
    pub fn resolve_export(&self, specifier: &str, name: &str) -> AmbientResolution {
        let declarations = self.declarations_for(specifier);
        if declarations.is_empty() {
            return AmbientResolution::NoDeclaration;
        }
        let [(_, declaration)] = declarations.as_slice() else {
            // Fix item 2: several files declare the SAME specifier --
            // workspace-ambiguous, never a guess at which one a real
            // TypeScript checker would even accept (declaration merging
            // across files for the SAME string-literal module name is
            // legal, but which member "wins" a name collision is not
            // something to reconstruct heuristically here).
            return AmbientResolution::Ambiguous;
        };
        // Fix item 3: a bodyless `declare module "specifier";` types the
        // whole module as `any` to the checker -- there is no declaration
        // for a named/default/namespace-value import to resolve to, so
        // TypeScript itself never provides a confirmed reference here.
        // Mirrored the same way: stay pending, NEVER promote to external
        // (the specifier IS ambiently declared -- just not usefully).
        if !declaration.bodyful {
            return AmbientResolution::Ambiguous;
        }
        match name {
            "*" => AmbientResolution::Resolved(declaration.namespace_entity_id.clone()),
            "default" => declaration
                .default_member
                .as_ref()
                .map(|member| AmbientResolution::Resolved(member.entity_id.clone()))
                .unwrap_or(AmbientResolution::Ambiguous),
            _ => {
                let matches: Vec<&AmbientModuleMember> = declaration
                    .members
                    .iter()
                    .filter(|member| member.name == name)
                    .collect();
                match matches.as_slice() {
                    [single] => AmbientResolution::Resolved(single.entity_id.clone()),
                    _ => AmbientResolution::Ambiguous,
                }
            }
        }
    }
}

/// TypeScript's ambient module wildcard match: `pattern` (containing
/// exactly one `*`, the only shape callers ever pass -- see `AmbientModule
/// Index::rebuild`'s own filter) matches `specifier` when `specifier`
/// starts with the text before `*` and ends with the text after it, with
/// enough length left over for the `*` to stand for something (`>= 0`
/// characters is enough per TypeScript's own rule -- `declare module
/// "*.css"` matches the literal specifier `".css"` too). Returns the
/// PREFIX length on a match (for `declarations_for`'s longest-prefix
/// precedence), `None` otherwise.
fn wildcard_prefix_match(pattern: &str, specifier: &str) -> Option<usize> {
    let star = pattern.find('*')?;
    let prefix = &pattern[..star];
    let suffix = &pattern[star + 1..];
    if specifier.len() >= prefix.len() + suffix.len()
        && specifier.starts_with(prefix)
        && specifier.ends_with(suffix)
    {
        Some(prefix.len())
    } else {
        None
    }
}

/// Outcome of [`AmbientModuleIndex::resolve_export`] -- see that method's
/// own doc comment.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AmbientResolution {
    /// No workspace file declares `declare module "specifier"` at all --
    /// the caller should fall through to `classify_external_specifier`.
    NoDeclaration,
    /// `specifier` IS ambiently declared somewhere in the workspace, but
    /// `name` does not resolve with certainty this way (several declaring
    /// files, a bodyless declaration, an unexported/absent/ambiguous
    /// member, ...) -- the caller MUST stay pending, never external.
    Ambiguous,
    Resolved(String),
}

/// Node.js core module names (2026, the well-established list -- a builtin
/// this list misses is not mis-classified as something else, it just stays
/// an ordinary bare package specifier for identity purposes: only the
/// `node:`-normalization in [`classify_external_specifier`] is skipped for
/// it, external-entity classification itself is unaffected).
const NODE_BUILTIN_MODULES: &[&str] = &[
    "assert",
    "async_hooks",
    "buffer",
    "child_process",
    "cluster",
    "console",
    "constants",
    "crypto",
    "dgram",
    "diagnostics_channel",
    "dns",
    "domain",
    "events",
    "fs",
    "http",
    "http2",
    "https",
    "inspector",
    "module",
    "net",
    "os",
    "path",
    "perf_hooks",
    "process",
    "punycode",
    "querystring",
    "readline",
    "repl",
    "stream",
    "string_decoder",
    "sys",
    "timers",
    "tls",
    "trace_events",
    "tty",
    "url",
    "util",
    "v8",
    "vm",
    "wasi",
    "worker_threads",
    "zlib",
];

/// External package/symbol entities task (2026-09-04): classifies an
/// IMPORT/EXPORT specifier that `WorkspaceResolver::resolve` already tried
/// and failed to resolve inside the workspace (`target_path.is_none()`) as
/// either a genuine external package/builtin specifier -- worth an
/// `external_module`/`external_symbol` entity -- or a relative/absolute
/// specifier that simply failed to resolve inside the workspace (a real
/// resolution gap: a broken path, a file outside the source frontier).
///
/// **The rule** (owner-approved, no checker involved, deliberately
/// conservative): a specifier starting with `.` (`./x`, `../x`) or `/` (an
/// absolute path) is NEVER external, regardless of why it failed to
/// resolve -- it named a real (or intended) file inside this workspace, and
/// inventing an external entity for it would misrepresent a resolution gap
/// as a real third-party dependency. An empty specifier (never valid
/// syntax, defensive only) is excluded the same way. Everything else --
/// a bare specifier (`lodash`), a scoped specifier (`@scope/name`), either
/// with a subpath (`lodash/get`, `@scope/name/sub`), or an explicit
/// `node:`-prefixed builtin -- is external.
///
/// **Identity normalization**: returns the CANONICAL specifier string to
/// build `external_module_id`/`external_symbol_id` from. A bare Node
/// builtin (`fs`) and its explicit `node:`-prefixed form (`node:fs`) name
/// the SAME entity (`jsts:external_module:node:fs`) -- both normalize to
/// the `node:`-prefixed form. A bare SUBPATH of a builtin (`fs/promises`,
/// h2 2026-09-05) normalizes the same way, full subpath included
/// (`node:fs/promises`) -- checked by splitting at the FIRST `/` and
/// matching only the prefix against [`NODE_BUILTIN_MODULES`], so a bare
/// package whose own name merely CONTAINS a builtin as a prefix component
/// of something else (`lodash/fp`: prefix `lodash` is not itself a
/// builtin) is left untouched. Every other specifier is returned AS-IS,
/// full subpath included: two different subpaths of the same non-builtin
/// package (`@langchain/core` vs `@langchain/core/messages`) are two
/// different external module entities, mirroring how two different
/// workspace files are two different module entities.
pub fn classify_external_specifier(specifier: &str) -> Option<String> {
    if specifier.is_empty() || specifier.starts_with('.') || specifier.starts_with('/') {
        return None;
    }
    if let Some(builtin) = specifier.strip_prefix("node:") {
        return Some(format!("node:{builtin}"));
    }
    if NODE_BUILTIN_MODULES.contains(&specifier) {
        return Some(format!("node:{specifier}"));
    }
    if let Some((prefix, _subpath)) = specifier.split_once('/')
        && NODE_BUILTIN_MODULES.contains(&prefix)
    {
        return Some(format!("node:{specifier}"));
    }
    Some(specifier.to_owned())
}

/// `jsts:external_module:{specifier}` -- `specifier` is the CANONICAL
/// specifier ([`classify_external_specifier`]'s return value), full subpath
/// included. A pure function of the specifier alone (never the importing
/// file), so every importer of the same specifier proposes a byte-identical
/// entity id -- see `urdira-indexing-worker::v4::analyze::run_scoped`'s
/// cross-owner dedup pass for why that is load-bearing.
pub fn external_module_id(specifier: &str) -> String {
    format!("jsts:external_module:{specifier}")
}

/// `jsts:external_symbol:{specifier}#{imported_name}` -- `imported_name` is
/// `"default"` for a default import/export, `"*"` for a namespace import's
/// own binding used as a value, or the plain imported/member name
/// otherwise. Also a pure function of its two inputs, for the same
/// cross-owner-dedup reason as [`external_module_id`].
pub fn external_symbol_id(specifier: &str, imported_name: &str) -> String {
    format!("jsts:external_symbol:{specifier}#{imported_name}")
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
            id: format!("jsts:{}:{path}:{start}:{name}", kind.identity_name()),
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
        file_with_star(path, entities, export_bindings, Vec::new())
    }

    /// 2026-09-04 references-parity task, bucket 2: same as `file` above,
    /// with an explicit `export_star_specifiers` list -- kept as a separate
    /// helper (rather than widening `file`'s own signature) so every
    /// PRE-EXISTING `file(...)` call site in this test module stays
    /// untouched.
    fn file_with_star(
        path: &str,
        entities: Vec<crate::SyntaxEntity>,
        export_bindings: Vec<SyntaxExportBinding>,
        export_star_specifiers: Vec<crate::ExportStarSpecifier>,
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
            export_star_specifiers,
            ambient_modules: Vec::new(),
            line_index: crate::LineIndex::from_text(""),
        }
    }

    /// Ambient module resolution task (2026-09-04): same as `file` above,
    /// with an explicit `ambient_modules` list -- kept as a separate helper
    /// (rather than widening `file`'s own signature) for the same reason
    /// `file_with_star` is.
    fn file_with_ambient(
        path: &str,
        ambient_modules: Vec<crate::AmbientModuleDeclaration>,
    ) -> SyntaxFileResult {
        let mut result = file_with_star(path, Vec::new(), Vec::new(), Vec::new());
        result.ambient_modules = ambient_modules;
        result
    }

    fn ambient_declaration(
        specifier: &str,
        path: &str,
        identity_start: u32,
        bodyful: bool,
        members: Vec<(&str, EntityKind, u32)>,
        default_member: Option<(&str, EntityKind, u32)>,
    ) -> crate::AmbientModuleDeclaration {
        crate::AmbientModuleDeclaration {
            specifier: specifier.to_owned(),
            bodyful,
            // Script-level by default -- augmentation tests flip this on
            // the returned value (`is_augmentation = true`) rather than
            // widening this helper's signature for every pre-existing
            // call site.
            is_augmentation: false,
            namespace_entity_id: format!("jsts:namespace:{path}:{identity_start}:{specifier}"),
            members: members
                .into_iter()
                .map(|(name, kind, start)| crate::AmbientModuleMember {
                    name: name.to_owned(),
                    entity_id: format!("jsts:{}:{path}:{start}:{name}", kind_word(kind)),
                })
                .collect(),
            default_member: default_member.map(|(name, kind, start)| crate::AmbientModuleMember {
                name: name.to_owned(),
                entity_id: format!("jsts:{}:{path}:{start}:{name}", kind_word(kind)),
            }),
        }
    }

    fn kind_word(kind: EntityKind) -> &'static str {
        match kind {
            EntityKind::Function => "function",
            EntityKind::Class => "class",
            EntityKind::Interface => "interface",
            EntityKind::Type => "type",
            EntityKind::Enum => "enum",
            EntityKind::Variable => "variable",
            other => panic!("unhandled entity kind in test helper: {other:?}"),
        }
    }

    fn star(specifier: &str, target_path: Option<&str>) -> crate::ExportStarSpecifier {
        crate::ExportStarSpecifier {
            specifier: specifier.to_owned(),
            target_path: target_path.map(str::to_owned),
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
            resolve_named_export(
                &files,
                "src/util.ts",
                "helper",
                ExportPolicy::UniqueOrAmbiguous
            ),
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
            resolve_named_export(
                &files,
                "src/index.ts",
                "Widget",
                ExportPolicy::UniqueOrAmbiguous
            ),
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
            resolve_named_export(
                &files,
                "src/overloads.ts",
                "f",
                ExportPolicy::UniqueOrAmbiguous
            ),
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
            resolve_named_export(
                &files,
                "src/index.ts",
                "helper",
                ExportPolicy::UniqueOrAmbiguous
            ),
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
            resolve_named_export(&files, "a.ts", "x", ExportPolicy::UniqueOrAmbiguous),
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
            resolve_named_export(&files, "index.ts", "evals", ExportPolicy::UniqueOrAmbiguous),
            ExportResolution::Namespace("evals/index.ts".to_owned())
        );
        // The whole point: a FURTHER member name resolves against the
        // re-exported module directly.
        assert_eq!(
            resolve_named_export(
                &files,
                "evals/index.ts",
                "stringSimilarity",
                ExportPolicy::UniqueOrAmbiguous
            ),
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
            resolve_named_export(&files, "mid.ts", "evals", ExportPolicy::UniqueOrAmbiguous),
            ExportResolution::Namespace("leaf.ts".to_owned())
        );
    }

    // 2026-09-04 references-parity task, bucket 2: `export * from "./x"`
    // barrel chasing (`resolve_via_export_star`).

    #[test]
    fn resolve_named_export_follows_single_star_barrel() {
        // `packages/.../index.ts` doing `export { X } from "../services"`
        // where `services/index.ts` itself does `export * from
        // "./credential-resolver-registry.service"` -- the exact shape this
        // task's evidence doc found live in the n8n corpus for the
        // `import_binding`/`re_export_binding` buckets.
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
            file_with_star(
                "src/index.ts",
                vec![],
                vec![],
                vec![star("./impl", Some("src/impl.ts"))],
            ),
        );
        assert_eq!(
            resolve_named_export(
                &files,
                "src/index.ts",
                "Widget",
                ExportPolicy::UniqueOrAmbiguous
            ),
            ExportResolution::Resolved("jsts:class:src/impl.ts:10:Widget".to_owned())
        );
    }

    #[test]
    fn resolve_named_export_star_barrel_only_used_when_direct_lookup_misses() {
        // A name matching a DIRECT/named-reexport binding in the barrel
        // itself must win over anything a star target might also provide --
        // `resolve_via_export_star` is only ever consulted when `matching`
        // is empty for `name` in `file` itself (see `resolve_named_export_
        // inner`'s own `[] => resolve_via_export_star(...)` arm).
        let mut files = BTreeMap::new();
        files.insert(
            "src/star-target.ts".to_owned(),
            file(
                "src/star-target.ts",
                vec![entity(EntityKind::Function, "src/star-target.ts", 1, "f")],
                vec![binding("f", "f", None, None)],
            ),
        );
        files.insert(
            "src/index.ts".to_owned(),
            file_with_star(
                "src/index.ts",
                vec![entity(EntityKind::Function, "src/index.ts", 50, "f")],
                vec![binding("f", "f", None, None)],
                vec![star("./star-target", Some("src/star-target.ts"))],
            ),
        );
        assert_eq!(
            resolve_named_export(&files, "src/index.ts", "f", ExportPolicy::UniqueOrAmbiguous),
            ExportResolution::Resolved("jsts:function:src/index.ts:50:f".to_owned())
        );
    }

    #[test]
    fn resolve_named_export_two_star_barrels_providing_same_name_stays_pending() {
        // Two DIFFERENT `export * from` targets both provide `helper` --
        // real ESM itself treats this as an error (an ambiguous export), so
        // this resolver must never guess which one wins.
        let mut files = BTreeMap::new();
        files.insert(
            "src/a.ts".to_owned(),
            file(
                "src/a.ts",
                vec![entity(EntityKind::Function, "src/a.ts", 1, "helper")],
                vec![binding("helper", "helper", None, None)],
            ),
        );
        files.insert(
            "src/b.ts".to_owned(),
            file(
                "src/b.ts",
                vec![entity(EntityKind::Function, "src/b.ts", 1, "helper")],
                vec![binding("helper", "helper", None, None)],
            ),
        );
        files.insert(
            "src/index.ts".to_owned(),
            file_with_star(
                "src/index.ts",
                vec![],
                vec![],
                vec![star("./a", Some("src/a.ts")), star("./b", Some("src/b.ts"))],
            ),
        );
        assert_eq!(
            resolve_named_export(
                &files,
                "src/index.ts",
                "helper",
                ExportPolicy::UniqueOrAmbiguous
            ),
            ExportResolution::Ambiguous
        );
    }

    #[test]
    fn resolve_named_export_star_barrel_name_not_found_anywhere_stays_pending() {
        let mut files = BTreeMap::new();
        files.insert(
            "src/a.ts".to_owned(),
            file(
                "src/a.ts",
                vec![entity(EntityKind::Function, "src/a.ts", 1, "other")],
                vec![binding("other", "other", None, None)],
            ),
        );
        files.insert(
            "src/index.ts".to_owned(),
            file_with_star(
                "src/index.ts",
                vec![],
                vec![],
                vec![star("./a", Some("src/a.ts"))],
            ),
        );
        assert_eq!(
            resolve_named_export(
                &files,
                "src/index.ts",
                "missing",
                ExportPolicy::UniqueOrAmbiguous
            ),
            ExportResolution::Unresolved
        );
    }

    #[test]
    fn resolve_named_export_star_barrel_unresolved_specifier_stays_pending() {
        // `star.target_path` is `None` (the specifier never resolved inside
        // the workspace, e.g. an external package) -- skipped, not a panic,
        // and contributes no candidate.
        let mut files = BTreeMap::new();
        files.insert(
            "src/index.ts".to_owned(),
            file_with_star("src/index.ts", vec![], vec![], vec![star("some-pkg", None)]),
        );
        assert_eq!(
            resolve_named_export(
                &files,
                "src/index.ts",
                "anything",
                ExportPolicy::UniqueOrAmbiguous
            ),
            ExportResolution::Unresolved
        );
    }

    #[test]
    fn resolve_named_export_star_chain_longer_than_depth_bound_stays_pending() {
        // A straight-line chain of `export * from` hops, ONE PER FILE:
        // `f0.ts` exports `target` directly; `f1.ts` star-re-exports
        // `f0.ts`; `f2.ts` star-re-exports `f1.ts`; ... `f8.ts`
        // star-re-exports `f7.ts`. Each hop costs one `depth` unit (`resolve_
        // via_export_star` recurses with `depth + 1`, same accounting as the
        // named-reexport chain), and `resolve_named_export_inner`'s own
        // guard rejects at `depth >= MAX_EXPORT_RESOLUTION_DEPTH` (8) BEFORE
        // looking at that node's own bindings. Resolving `target` from
        // `f8.ts` needs `f0` to be reached at `depth == 8` (one too many --
        // the guard fires), so it must stay `Unresolved` -- never silently
        // truncate to a WRONG (but reachable-within-bound) answer. Resolving
        // from `f7.ts` needs `f0` reached at `depth == 7` (within bound) and
        // DOES resolve, proving the failure above is the depth bound itself,
        // not a mistake in the fixture.
        let mut files = BTreeMap::new();
        files.insert(
            "f0.ts".to_owned(),
            file(
                "f0.ts",
                vec![entity(EntityKind::Function, "f0.ts", 1, "target")],
                vec![binding("target", "target", None, None)],
            ),
        );
        for hop in 1..=8u32 {
            let path = format!("f{hop}.ts");
            let prior = format!("f{}.ts", hop - 1);
            files.insert(
                path.clone(),
                file_with_star(&path, vec![], vec![], vec![star("./prior", Some(&prior))]),
            );
        }
        assert_eq!(
            resolve_named_export(&files, "f8.ts", "target", ExportPolicy::UniqueOrAmbiguous),
            ExportResolution::Unresolved
        );
        assert_eq!(
            resolve_named_export(&files, "f7.ts", "target", ExportPolicy::UniqueOrAmbiguous),
            ExportResolution::Resolved("jsts:function:f0.ts:1:target".to_owned())
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

    #[test]
    fn classify_external_specifier_accepts_bare_scoped_and_subpath_packages() {
        assert_eq!(
            classify_external_specifier("lodash"),
            Some("lodash".to_owned())
        );
        assert_eq!(
            classify_external_specifier("lodash/get"),
            Some("lodash/get".to_owned())
        );
        assert_eq!(
            classify_external_specifier("@langchain/core"),
            Some("@langchain/core".to_owned())
        );
        assert_eq!(
            classify_external_specifier("@langchain/core/messages"),
            Some("@langchain/core/messages".to_owned())
        );
    }

    #[test]
    fn classify_external_specifier_normalizes_node_builtins() {
        assert_eq!(
            classify_external_specifier("fs"),
            Some("node:fs".to_owned())
        );
        assert_eq!(
            classify_external_specifier("node:fs"),
            Some("node:fs".to_owned())
        );
        assert_eq!(
            classify_external_specifier("path"),
            Some("node:path".to_owned())
        );
        assert_eq!(
            classify_external_specifier("node:fs/promises"),
            Some("node:fs/promises".to_owned())
        );
    }

    /// h2 (2026-09-05): a bare SUBPATH of a builtin normalizes the same way
    /// the exact builtin name does, full subpath included -- these eight are
    /// the ones the plan named. `lodash/fp`'s prefix (`lodash`) is not a
    /// builtin, so it stays untouched, same as any other scoped/subpath
    /// package.
    #[test]
    fn classify_external_specifier_normalizes_node_builtin_subpaths() {
        for (specifier, expected) in [
            ("fs/promises", "node:fs/promises"),
            ("stream/web", "node:stream/web"),
            ("path/posix", "node:path/posix"),
            ("util/types", "node:util/types"),
            ("timers/promises", "node:timers/promises"),
            ("assert/strict", "node:assert/strict"),
            ("dns/promises", "node:dns/promises"),
            ("readline/promises", "node:readline/promises"),
        ] {
            assert_eq!(
                classify_external_specifier(specifier),
                Some(expected.to_owned()),
                "specifier: {specifier}"
            );
        }
        assert_eq!(
            classify_external_specifier("lodash/fp"),
            Some("lodash/fp".to_owned())
        );
    }

    #[test]
    fn classify_external_specifier_excludes_relative_and_absolute() {
        assert_eq!(classify_external_specifier("./sibling"), None);
        assert_eq!(classify_external_specifier("../parent"), None);
        assert_eq!(classify_external_specifier("/abs/path"), None);
        assert_eq!(classify_external_specifier(""), None);
    }

    #[test]
    fn external_id_recipes_are_pure_and_deterministic() {
        assert_eq!(
            external_module_id("@langchain/core/messages"),
            "jsts:external_module:@langchain/core/messages"
        );
        assert_eq!(
            external_symbol_id("lodash", "get"),
            "jsts:external_symbol:lodash#get"
        );
        assert_eq!(
            external_symbol_id("express", "default"),
            "jsts:external_symbol:express#default"
        );
        assert_eq!(
            external_symbol_id("lodash", "*"),
            "jsts:external_symbol:lodash#*"
        );
    }

    // -- Ambient module resolution task (2026-09-04) ---------------------

    #[test]
    fn ambient_named_export_resolves_to_the_inner_declaration() {
        let mut files = BTreeMap::new();
        files.insert(
            "plugins.d.ts".to_owned(),
            file_with_ambient(
                "plugins.d.ts",
                vec![ambient_declaration(
                    "eslint-plugin-lodash",
                    "plugins.d.ts",
                    10,
                    true,
                    vec![("configure", EntityKind::Function, 40)],
                    None,
                )],
            ),
        );
        let index = AmbientModuleIndex::rebuild(&files);
        assert_eq!(
            index.resolve_export("eslint-plugin-lodash", "configure"),
            AmbientResolution::Resolved("jsts:function:plugins.d.ts:40:configure".to_owned())
        );
        assert_eq!(
            index.unique_namespace_entity("eslint-plugin-lodash"),
            Some("jsts:namespace:plugins.d.ts:10:eslint-plugin-lodash".to_owned())
        );
        assert!(index.has_any_declaration("eslint-plugin-lodash"));
    }

    #[test]
    fn ambient_default_export_resolves_to_the_inner_declaration() {
        let mut files = BTreeMap::new();
        files.insert(
            "plugins.d.ts".to_owned(),
            file_with_ambient(
                "plugins.d.ts",
                vec![ambient_declaration(
                    "my-widget",
                    "plugins.d.ts",
                    10,
                    true,
                    vec![],
                    Some(("Widget", EntityKind::Class, 50)),
                )],
            ),
        );
        let index = AmbientModuleIndex::rebuild(&files);
        assert_eq!(
            index.resolve_export("my-widget", "default"),
            AmbientResolution::Resolved("jsts:class:plugins.d.ts:50:Widget".to_owned())
        );
    }

    #[test]
    fn ambient_namespace_value_import_resolves_to_the_block_entity() {
        let mut files = BTreeMap::new();
        files.insert(
            "plugins.d.ts".to_owned(),
            file_with_ambient(
                "plugins.d.ts",
                vec![ambient_declaration(
                    "my-widget",
                    "plugins.d.ts",
                    10,
                    true,
                    vec![("Widget", EntityKind::Class, 50)],
                    None,
                )],
            ),
        );
        let index = AmbientModuleIndex::rebuild(&files);
        assert_eq!(
            index.resolve_export("my-widget", "*"),
            AmbientResolution::Resolved("jsts:namespace:plugins.d.ts:10:my-widget".to_owned())
        );
    }

    #[test]
    fn ambient_shorthand_declaration_stays_ambiguous_never_external() {
        let mut files = BTreeMap::new();
        files.insert(
            "globals.d.ts".to_owned(),
            file_with_ambient(
                "globals.d.ts",
                vec![ambient_declaration(
                    "*.css",
                    "globals.d.ts",
                    5,
                    false,
                    vec![],
                    None,
                )],
            ),
        );
        let index = AmbientModuleIndex::rebuild(&files);
        assert_eq!(
            index.resolve_export("*.css", "default"),
            AmbientResolution::Ambiguous
        );
        // A shorthand block still has NO usable module-edge target either
        // (fix item 2's "namespace entity id" rule applies to relations,
        // not name resolution -- but this index reports `unique_namespace_
        // entity` for it regardless, matching v3's own `addEntity`, which
        // gives the `TSModuleDeclaration` node an entity even bodyless; it
        // is only `resolve_export`'s NAME-level answer that stays pending).
        assert_eq!(
            index.unique_namespace_entity("*.css"),
            Some("jsts:namespace:globals.d.ts:5:*.css".to_owned())
        );
    }

    #[test]
    fn ambient_declared_by_two_files_stays_ambiguous_never_external() {
        let mut files = BTreeMap::new();
        files.insert(
            "a.d.ts".to_owned(),
            file_with_ambient(
                "a.d.ts",
                vec![ambient_declaration(
                    "shared-pkg",
                    "a.d.ts",
                    1,
                    true,
                    vec![("thing", EntityKind::Function, 20)],
                    None,
                )],
            ),
        );
        files.insert(
            "b.d.ts".to_owned(),
            file_with_ambient(
                "b.d.ts",
                vec![ambient_declaration(
                    "shared-pkg",
                    "b.d.ts",
                    1,
                    true,
                    vec![("thing", EntityKind::Function, 20)],
                    None,
                )],
            ),
        );
        let index = AmbientModuleIndex::rebuild(&files);
        assert_eq!(
            index.resolve_export("shared-pkg", "thing"),
            AmbientResolution::Ambiguous
        );
        assert_eq!(index.unique_namespace_entity("shared-pkg"), None);
        assert!(index.has_any_declaration("shared-pkg"));
    }

    /// n8n corpus regression: `declare module '~icons/*' { const component:
    /// T; export default component; }` -- ALL 649 remaining
    /// `v4_different_target` rows after the exact-match fix traced back to
    /// this ONE wildcard declaration.
    #[test]
    fn wildcard_ambient_declaration_matches_any_specifier_sharing_its_prefix() {
        let mut files = BTreeMap::new();
        files.insert(
            "env.d.ts".to_owned(),
            file_with_ambient(
                "env.d.ts",
                vec![ambient_declaration(
                    "~icons/*",
                    "env.d.ts",
                    20,
                    true,
                    vec![],
                    Some(("component", EntityKind::Variable, 60)),
                )],
            ),
        );
        let index = AmbientModuleIndex::rebuild(&files);
        assert_eq!(
            index.resolve_export("~icons/lucide/message-square", "default"),
            AmbientResolution::Resolved("jsts:variable:env.d.ts:60:component".to_owned())
        );
        assert_eq!(
            index.unique_namespace_entity("~icons/lucide/message-square"),
            Some("jsts:namespace:env.d.ts:20:~icons/*".to_owned())
        );
        // A specifier that does NOT share the pattern's prefix is untouched.
        assert_eq!(
            index.resolve_export("lodash", "default"),
            AmbientResolution::NoDeclaration
        );
    }

    #[test]
    fn a_literal_declaration_takes_precedence_over_a_wildcard_for_the_same_specifier() {
        let mut files = BTreeMap::new();
        files.insert(
            "env.d.ts".to_owned(),
            file_with_ambient(
                "env.d.ts",
                vec![ambient_declaration(
                    "~icons/*",
                    "env.d.ts",
                    20,
                    true,
                    vec![],
                    Some(("component", EntityKind::Variable, 60)),
                )],
            ),
        );
        files.insert(
            "exact.d.ts".to_owned(),
            file_with_ambient(
                "exact.d.ts",
                vec![ambient_declaration(
                    "~icons/lucide/message-square",
                    "exact.d.ts",
                    5,
                    true,
                    vec![("specificThing", EntityKind::Function, 40)],
                    None,
                )],
            ),
        );
        let index = AmbientModuleIndex::rebuild(&files);
        assert_eq!(
            index.resolve_export("~icons/lucide/message-square", "specificThing"),
            AmbientResolution::Resolved("jsts:function:exact.d.ts:40:specificThing".to_owned())
        );
    }

    #[test]
    fn two_wildcard_patterns_tied_at_the_same_prefix_length_stay_ambiguous() {
        let mut files = BTreeMap::new();
        files.insert(
            "a.d.ts".to_owned(),
            file_with_ambient(
                "a.d.ts",
                vec![ambient_declaration(
                    "~icons/*",
                    "a.d.ts",
                    1,
                    true,
                    vec![],
                    Some(("thing", EntityKind::Variable, 10)),
                )],
            ),
        );
        files.insert(
            "b.d.ts".to_owned(),
            file_with_ambient(
                "b.d.ts",
                vec![ambient_declaration(
                    "~icons/*",
                    "b.d.ts",
                    1,
                    true,
                    vec![],
                    Some(("thing", EntityKind::Variable, 10)),
                )],
            ),
        );
        let index = AmbientModuleIndex::rebuild(&files);
        assert_eq!(
            index.resolve_export("~icons/lucide/message-square", "default"),
            AmbientResolution::Ambiguous
        );
    }

    #[test]
    fn specifier_with_no_ambient_declaration_reports_no_declaration() {
        let files: BTreeMap<String, SyntaxFileResult> = BTreeMap::new();
        let index = AmbientModuleIndex::rebuild(&files);
        assert_eq!(
            index.resolve_export("lodash", "get"),
            AmbientResolution::NoDeclaration
        );
        assert!(!index.has_any_declaration("lodash"));
        assert_eq!(index.unique_namespace_entity("lodash"), None);
    }

    /// Owner-flagged follow-up (2026-09-04): a MODULE AUGMENTATION
    /// (`declare module "vue" { ... }` inside a file that itself has
    /// top-level `import`/`export` syntax) must be ignored for resolution
    /// entirely -- it never enters the index, so `vue` stays externally
    /// classified (never "workspace-ambiguous"/pending) for every real
    /// importer.
    #[test]
    fn module_augmentation_is_ignored_for_resolution() {
        let mut files = BTreeMap::new();
        let mut augmentation = file_with_ambient(
            "vue-augmentation.d.ts",
            vec![ambient_declaration(
                "vue",
                "vue-augmentation.d.ts",
                10,
                true,
                vec![("ComponentCustomProperties", EntityKind::Interface, 30)],
                None,
            )],
        );
        augmentation.ambient_modules[0].is_augmentation = true;
        files.insert("vue-augmentation.d.ts".to_owned(), augmentation);
        let index = AmbientModuleIndex::rebuild(&files);
        assert_eq!(
            index.resolve_export("vue", "ComponentCustomProperties"),
            AmbientResolution::NoDeclaration,
            "an augmentation must never make `vue` resolve ambiently"
        );
        assert!(
            !index.has_any_declaration("vue"),
            "an augmentation must be invisible to has_any_declaration too, \
             so `vue` still falls through to classify_external_specifier \
             instead of becoming workspace-ambiguous"
        );
        assert_eq!(index.unique_namespace_entity("vue"), None);
    }

    /// A genuine script-level ambient declaration for the SAME specifier a
    /// DIFFERENT file merely augments must still resolve normally -- the
    /// augmentation is invisible, not merely deprioritized.
    #[test]
    fn a_script_declaration_resolves_even_when_another_file_only_augments_the_same_specifier() {
        let mut files = BTreeMap::new();
        let mut augmentation = file_with_ambient(
            "vue-augmentation.d.ts",
            vec![ambient_declaration(
                "my-lib",
                "vue-augmentation.d.ts",
                10,
                true,
                vec![("Extra", EntityKind::Interface, 30)],
                None,
            )],
        );
        augmentation.ambient_modules[0].is_augmentation = true;
        files.insert("vue-augmentation.d.ts".to_owned(), augmentation);
        files.insert(
            "shim.d.ts".to_owned(),
            file_with_ambient(
                "shim.d.ts",
                vec![ambient_declaration(
                    "my-lib",
                    "shim.d.ts",
                    5,
                    true,
                    vec![("thing", EntityKind::Function, 20)],
                    None,
                )],
            ),
        );
        let index = AmbientModuleIndex::rebuild(&files);
        assert_eq!(
            index.resolve_export("my-lib", "thing"),
            AmbientResolution::Resolved("jsts:function:shim.d.ts:20:thing".to_owned())
        );
    }

    // A5b (2026-09-05 references-parity task), bucket 1: barrel re-export of
    // an imported binding (`import { X } from './x'; export { X };`, no
    // `from` on the `export` itself) -- see `resolve_direct_export`'s own
    // doc comment for why the OTHER sub-bucket this task measured (function
    // overloads) was deliberately left unimplemented.

    #[test]
    fn resolve_named_export_follows_barrel_reexport_of_an_imported_binding() {
        // A5b bucket 1: what `SyntaxCollector::visit_export_specifier` now
        // emits for `import { Widget } from './impl'; export { Widget };`
        // in a barrel -- a re-export binding (`source_specifier` set, NOT a
        // local declaration lookup), already resolved to `source_target_
        // path` here exactly as `parse_source`'s own generic per-binding
        // pass would leave it. `resolve_named_export` must chase it exactly
        // like an ordinary with-source `export { a } from "./x"` re-export
        // (`resolve_named_export_follows_one_hop_reexport`'s own sibling
        // test), landing on the REAL declaration in the target file, not
        // `Unresolved` (the pre-fix behavior: the old sourceless-specifier
        // path treated `local_name: "Widget"` as a same-file declaration
        // name, and a barrel re-exporting an import never has one).
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
            resolve_named_export(
                &files,
                "src/index.ts",
                "Widget",
                ExportPolicy::UniqueOrAmbiguous
            ),
            ExportResolution::Resolved("jsts:class:src/impl.ts:10:Widget".to_owned())
        );
    }

    #[test]
    fn resolve_named_export_barrel_reexport_of_a_default_import() {
        // `import Def from './impl'; export { Def };` -> A5b's
        // `ImportedName::Default` arm gives this binding `local_name:
        // "default"`, the SAME local name a with-source `export { default as
        // X } from "./impl"` already produces (see `visit_export_specifier`'s
        // own doc comment) -- both must resolve through the SAME `name ==
        // "default"` lookup `visit_export_default_declaration` populates.
        let mut files = BTreeMap::new();
        files.insert(
            "src/impl.ts".to_owned(),
            file(
                "src/impl.ts",
                vec![entity(EntityKind::Function, "src/impl.ts", 10, "Widget")],
                vec![binding("default", "Widget", None, None)],
            ),
        );
        files.insert(
            "src/index.ts".to_owned(),
            file(
                "src/index.ts",
                vec![],
                vec![binding(
                    "Def",
                    "default",
                    Some("./impl"),
                    Some("src/impl.ts"),
                )],
            ),
        );
        assert_eq!(
            resolve_named_export(
                &files,
                "src/index.ts",
                "Def",
                ExportPolicy::UniqueOrAmbiguous
            ),
            ExportResolution::Resolved("jsts:function:src/impl.ts:10:Widget".to_owned())
        );
    }
}
