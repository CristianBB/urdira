//! Byte-for-byte port of `packages/security/src/inclusion.ts`'s
//! `evaluateInclusion`/`glob` and of `DEFAULT_WORKSPACE_INCLUSION` from
//! `packages/engine/src/directory-provider.ts`. Kept as a hand-rolled
//! backtracking matcher (not a compiled `regex`) so this crate needs no new
//! regex dependency: `glob_match` translates the same five pattern
//! constructs the TS `glob()` function does (`**/`, lone `**`, `*`, `?`,
//! literal) into the same anchored full-string match, one recursive
//! branch per construct.

/// Mirrors `InclusionRules` (`packages/security/src/inclusion.ts`).
#[derive(Debug, Clone)]
pub struct InclusionRules {
    pub include: Vec<String>,
    pub exclude: Vec<String>,
    pub allow_external_root: bool,
    pub follow_symlinks: bool,
    pub allowed_external_roots: Vec<String>,
    /// `None` reproduces the TS default of `[...exclude.map(exclude), ...include.map(include)]`.
    pub ordered_rules: Option<Vec<(RuleKind, String)>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuleKind {
    Include,
    Exclude,
}

/// `DEFAULT_WORKSPACE_INCLUSION` (`packages/engine/src/directory-provider.ts:210`).
pub fn default_workspace_inclusion() -> InclusionRules {
    InclusionRules {
        include: Vec::new(),
        exclude: vec![
            "node_modules/**".to_string(),
            ".git/**".to_string(),
            "dist/**".to_string(),
            "coverage/**".to_string(),
            "tests/baselines/**".to_string(),
            "tests/cases/**".to_string(),
            ".urdira/**".to_string(),
        ],
        allow_external_root: false,
        follow_symlinks: false,
        allowed_external_roots: Vec::new(),
        ordered_rules: None,
    }
}

/// Mirrors `GitIgnoreRules`. Off by default, exactly like
/// `DirectorySourceProvider`'s own `DEFAULT_GITIGNORE = { enabled: false,
/// patterns: [] }`.
#[derive(Debug, Clone, Default)]
pub struct GitIgnoreRules {
    pub enabled: bool,
    pub patterns: Vec<String>,
}

/// Mirrors `InclusionObservation`.
#[derive(Debug, Clone)]
pub struct InclusionObservation<'a> {
    pub normalized_path: &'a str,
    pub is_symlink: bool,
    pub is_directory: bool,
    pub byte_length: u64,
    pub media_type: &'a str,
    pub outside_allowed_root: bool,
    pub symlink_cycle: bool,
    pub is_special: bool,
}

/// Mirrors `InclusionResult`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InclusionResult {
    pub included: bool,
    pub reason_code: &'static str,
    pub matched_rule: Option<String>,
}

fn excluded(reason_code: &'static str) -> InclusionResult {
    InclusionResult {
        included: false,
        reason_code,
        matched_rule: None,
    }
}

fn excluded_with(reason_code: &'static str, matched_rule: String) -> InclusionResult {
    InclusionResult {
        included: false,
        reason_code,
        matched_rule: Some(matched_rule),
    }
}

fn included(reason_code: &'static str) -> InclusionResult {
    InclusionResult {
        included: true,
        reason_code,
        matched_rule: None,
    }
}

fn included_with(reason_code: &'static str, matched_rule: String) -> InclusionResult {
    InclusionResult {
        included: true,
        reason_code,
        matched_rule: Some(matched_rule),
    }
}

#[derive(Debug, Clone, Copy)]
enum Token {
    Literal(char),
    Question,
    Star,
    DoubleStarSlash,
    DoubleStarAny,
}

fn compile_glob(pattern: &str) -> (Vec<Token>, bool) {
    let normalized = pattern.replace('\\', "/");
    let normalized = normalized
        .strip_prefix(".!/")
        .unwrap_or(&normalized)
        .to_string();
    let has_slash = normalized.contains('/');
    let chars: Vec<char> = normalized.chars().collect();
    let mut tokens = Vec::with_capacity(chars.len());
    let mut index = 0usize;
    while index < chars.len() {
        let c = chars[index];
        if c == '*' && chars.get(index + 1) == Some(&'*') {
            if chars.get(index + 2) == Some(&'/') {
                tokens.push(Token::DoubleStarSlash);
                index += 3;
            } else {
                tokens.push(Token::DoubleStarAny);
                index += 2;
            }
        } else if c == '*' {
            tokens.push(Token::Star);
            index += 1;
        } else if c == '?' {
            tokens.push(Token::Question);
            index += 1;
        } else {
            tokens.push(Token::Literal(c));
            index += 1;
        }
    }
    (tokens, has_slash)
}

fn match_tokens(tokens: &[Token], text: &[char]) -> bool {
    match tokens.first() {
        None => text.is_empty(),
        Some(Token::Literal(expected)) => {
            matches!(text.first(), Some(actual) if actual == expected)
                && match_tokens(&tokens[1..], &text[1..])
        }
        Some(Token::Question) => {
            matches!(text.first(), Some(actual) if *actual != '/')
                && match_tokens(&tokens[1..], &text[1..])
        }
        Some(Token::Star) => {
            let mut end = 0usize;
            loop {
                if match_tokens(&tokens[1..], &text[end..]) {
                    return true;
                }
                if end >= text.len() || text[end] == '/' {
                    return false;
                }
                end += 1;
            }
        }
        Some(Token::DoubleStarAny) => {
            let mut end = 0usize;
            loop {
                if match_tokens(&tokens[1..], &text[end..]) {
                    return true;
                }
                if end >= text.len() {
                    return false;
                }
                end += 1;
            }
        }
        Some(Token::DoubleStarSlash) => {
            if match_tokens(&tokens[1..], text) {
                return true;
            }
            for index in 0..text.len() {
                if text[index] == '/' && match_tokens(&tokens[1..], &text[index + 1..]) {
                    return true;
                }
            }
            false
        }
    }
}

/// Port of `glob(pattern, value)`. A pattern without a `/` matches only the
/// final path segment of `value`; one with a `/` matches the whole value.
pub fn glob_match(pattern: &str, value: &str) -> bool {
    let (tokens, has_slash) = compile_glob(pattern);
    let target: &str = if has_slash {
        value
    } else {
        value.rsplit('/').next().unwrap_or(value)
    };
    let text: Vec<char> = target.chars().collect();
    match_tokens(&tokens, &text)
}

/// Port of `matches(patterns, path)`: the pattern occurring LAST in
/// `patterns`' own order that matches `path` (implemented as reverse-order
/// `find`, matching the TS `[...patterns].reverse().find(...)`).
fn last_matching(patterns: &[String], path: &str) -> Option<String> {
    patterns
        .iter()
        .rev()
        .find(|pattern| glob_match(pattern, path))
        .cloned()
}

/// Port of `gitIgnoreMatch`.
fn gitignore_match(patterns: &[String], path: &str) -> Option<(bool, String)> {
    let mut decision = None;
    for pattern in patterns {
        if pattern.is_empty() || pattern.starts_with('#') {
            continue;
        }
        let negated = pattern.starts_with('!');
        let candidate = if negated {
            &pattern[1..]
        } else {
            pattern.as_str()
        };
        if glob_match(candidate, path) {
            decision = Some((!negated, pattern.clone()));
        }
    }
    decision
}

const BINARY_LIKE_PATH: &[&str] = &["node_modules", "dist", "coverage", ".git"];

/// True for a path with a `node_modules`, `dist`, `coverage`, or `.git`
/// DIRECTORY segment somewhere above the final component (port of the TS
/// inline regex `/(?:^|\/)(?:node_modules|dist|coverage|\.git)\//`, which
/// requires a trailing `/` after the matched name and so can never match
/// the path's own final segment).
fn has_generated_or_vcs_segment(path: &str) -> bool {
    let segments: Vec<&str> = path.split('/').collect();
    if segments.len() < 2 {
        return false;
    }
    segments[..segments.len() - 1]
        .iter()
        .any(|segment| BINARY_LIKE_PATH.contains(segment))
}

/// Byte-for-byte port of `evaluateInclusion`
/// (`packages/security/src/inclusion.ts:52`).
pub fn evaluate_inclusion(
    observation: &InclusionObservation<'_>,
    rules: &InclusionRules,
    gitignore: &GitIgnoreRules,
) -> InclusionResult {
    if observation.outside_allowed_root {
        return excluded("security:external_root_forbidden");
    }
    if observation.symlink_cycle {
        return excluded("security:symlink_cycle");
    }
    if observation.is_special {
        return excluded("security:path_invalid");
    }
    if observation.is_symlink && !rules.follow_symlinks {
        return excluded("security:symlink_forbidden");
    }
    let path = observation.normalized_path.replace('\\', "/");
    let looks_windows_absolute = path.len() >= 2
        && path.as_bytes()[0].is_ascii_alphabetic()
        && path.as_bytes()[1] == b':'
        && path.as_bytes().get(2) == Some(&b'/');
    if path.starts_with('/')
        || path.split('/').any(|segment| segment == "..")
        || looks_windows_absolute
    {
        return excluded("security:path_outside_workspace");
    }
    if path == ".git"
        || path.starts_with(".git/")
        || path == ".urdira"
        || path.starts_with(".urdira/")
    {
        return excluded("security:mandatory_exclusion");
    }
    if observation.is_directory {
        return excluded("security:directory_not_artifact");
    }
    if observation.byte_length > 10 * 1024 * 1024 {
        return excluded("security:size_exclusion");
    }
    if (observation
        .media_type
        .starts_with("application/octet-stream")
        || has_generated_or_vcs_segment(&path))
        && last_matching(&rules.include, &path).is_none()
    {
        return excluded("security:generated_or_binary_default");
    }
    let explicit_decision: Option<(RuleKind, String)> = match &rules.ordered_rules {
        Some(ordered) => {
            let mut decision = None;
            for (kind, pattern) in ordered {
                if glob_match(pattern, &path) {
                    decision = Some((*kind, pattern.clone()));
                }
            }
            decision
        }
        None => {
            let mut decision = None;
            for pattern in &rules.exclude {
                if glob_match(pattern, &path) {
                    decision = Some((RuleKind::Exclude, pattern.clone()));
                }
            }
            for pattern in &rules.include {
                if glob_match(pattern, &path) {
                    decision = Some((RuleKind::Include, pattern.clone()));
                }
            }
            decision
        }
    };
    match explicit_decision {
        Some((RuleKind::Exclude, pattern)) => {
            return excluded_with("security:workspace_exclusion", pattern);
        }
        Some((RuleKind::Include, pattern)) => {
            return included_with("security:explicit_include", pattern);
        }
        None => {}
    }
    if gitignore.enabled
        && let Some((true, rule)) = gitignore_match(&gitignore.patterns, &path)
    {
        return excluded_with("security:gitignore", rule);
    }
    included("security:eligible_default")
}

const BINARY_EXTENSIONS: &[&str] = &[
    ".7z", ".avi", ".bin", ".bmp", ".class", ".dll", ".dylib", ".eot", ".exe", ".gif", ".gz",
    ".ico", ".jar", ".jpeg", ".jpg", ".mov", ".mp3", ".mp4", ".o", ".pdf", ".png", ".so", ".tar",
    ".wasm", ".webp", ".woff", ".woff2", ".zip",
];

/// Port of Node's `path.extname` for the POSIX paths this crate deals in:
/// the last `.` in the final path segment, unless it is the segment's first
/// character (a dotfile with no further `.` has no extension). Lowercased
/// to match `directory-provider.ts`'s `extname(path).toLowerCase()` call
/// sites.
fn extname_lower(path: &str) -> String {
    let basename = path.rsplit('/').next().unwrap_or(path);
    match basename.rfind('.') {
        Some(0) => String::new(),
        Some(index) => basename[index..].to_ascii_lowercase(),
        None => String::new(),
    }
}

/// Port of `computeMediaType`/`mediaType` (`directory-provider.ts:452-467`):
/// a known binary extension or any NUL byte is `application/octet-stream`;
/// otherwise valid UTF-8 is `text/plain`, invalid UTF-8 falls back to
/// `application/octet-stream`.
pub fn compute_media_type(path: &str, bytes: &[u8]) -> &'static str {
    if BINARY_EXTENSIONS.contains(&extname_lower(path).as_str()) || bytes.contains(&0u8) {
        return "application/octet-stream";
    }
    if std::str::from_utf8(bytes).is_ok() {
        "text/plain"
    } else {
        "application/octet-stream"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn glob_matches_default_exclusions() {
        assert!(glob_match("node_modules/**", "node_modules/pkg/index.js"));
        assert!(glob_match(".git/**", ".git/HEAD"));
        assert!(!glob_match("node_modules/**", "src/node_modules_helper.ts"));
        assert!(glob_match("**/*.ts", "src/sub/a.ts"));
        assert!(glob_match("*.ts", "a.ts"));
        // A slash-free pattern matches only the final path segment (port of
        // TS's `target = normalized.includes("/") ? value :
        // value.split("/").at(-1)`), so it still matches a nested file's
        // basename — it is not anchored to the whole relative path.
        assert!(glob_match("*.ts", "src/a.ts"));
        assert!(!glob_match("*.ts", "src/a.tsx"));
    }

    #[test]
    fn extname_matches_node_semantics() {
        assert_eq!(extname_lower("src/a.PNG"), ".png");
        assert_eq!(extname_lower(".gitignore"), "");
        assert_eq!(extname_lower("src/archive.tar.gz"), ".gz");
        assert_eq!(extname_lower("src/no_extension"), "");
    }

    fn observe<'a>(
        path: &'a str,
        byte_length: u64,
        media_type: &'a str,
    ) -> InclusionObservation<'a> {
        InclusionObservation {
            normalized_path: path,
            is_symlink: false,
            is_directory: false,
            byte_length,
            media_type,
            outside_allowed_root: false,
            symlink_cycle: false,
            is_special: false,
        }
    }

    #[test]
    fn default_rules_exclude_node_modules_and_dotgit_and_dotdir() {
        let rules = default_workspace_inclusion();
        let gitignore = GitIgnoreRules::default();
        assert!(
            !evaluate_inclusion(
                &observe("node_modules/pkg/index.js", 10, "text/plain"),
                &rules,
                &gitignore
            )
            .included
        );
        assert!(
            !evaluate_inclusion(&observe(".git/HEAD", 10, "text/plain"), &rules, &gitignore)
                .included
        );
        assert!(
            !evaluate_inclusion(
                &observe(".urdira/db.sqlite", 10, "application/octet-stream"),
                &rules,
                &gitignore
            )
            .included
        );
        let result = evaluate_inclusion(&observe("src/a.ts", 10, "text/plain"), &rules, &gitignore);
        assert!(result.included);
        assert_eq!(result.reason_code, "security:eligible_default");
    }

    #[test]
    fn binary_media_type_excluded_unless_explicitly_included() {
        let rules = default_workspace_inclusion();
        let gitignore = GitIgnoreRules::default();
        let result = evaluate_inclusion(
            &observe("src/img.png", 10, "application/octet-stream"),
            &rules,
            &gitignore,
        );
        assert!(!result.included);
        assert_eq!(result.reason_code, "security:generated_or_binary_default");

        let mut with_include = rules.clone();
        with_include.include.push("src/img.png".to_string());
        let allowed = evaluate_inclusion(
            &observe("src/img.png", 10, "application/octet-stream"),
            &with_include,
            &gitignore,
        );
        assert!(allowed.included);
    }

    #[test]
    fn oversized_file_is_excluded() {
        let rules = default_workspace_inclusion();
        let gitignore = GitIgnoreRules::default();
        let result = evaluate_inclusion(
            &observe("src/big.txt", 10 * 1024 * 1024 + 1, "text/plain"),
            &rules,
            &gitignore,
        );
        assert!(!result.included);
        assert_eq!(result.reason_code, "security:size_exclusion");
    }

    #[test]
    fn gitignore_patterns_apply_only_when_enabled() {
        let rules = default_workspace_inclusion();
        let disabled = GitIgnoreRules::default();
        assert!(
            evaluate_inclusion(
                &observe("build/output.js", 10, "text/plain"),
                &rules,
                &disabled
            )
            .included
        );

        let enabled = GitIgnoreRules {
            enabled: true,
            patterns: vec!["build/**".to_string()],
        };
        let result = evaluate_inclusion(
            &observe("build/output.js", 10, "text/plain"),
            &rules,
            &enabled,
        );
        assert!(!result.included);
        assert_eq!(result.reason_code, "security:gitignore");
    }

    #[test]
    fn include_pattern_after_exclude_wins_last_match_semantics() {
        let mut rules = default_workspace_inclusion();
        rules.exclude.push("src/**".to_string());
        rules.include.push("src/keep.ts".to_string());
        let gitignore = GitIgnoreRules::default();
        let excluded_file = evaluate_inclusion(
            &observe("src/drop.ts", 10, "text/plain"),
            &rules,
            &gitignore,
        );
        assert!(!excluded_file.included);
        let included_file = evaluate_inclusion(
            &observe("src/keep.ts", 10, "text/plain"),
            &rules,
            &gitignore,
        );
        assert!(included_file.included);
        assert_eq!(included_file.reason_code, "security:explicit_include");
    }
}
