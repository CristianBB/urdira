//! Locates the `tsgo` (TypeScript 7, Go-ported checker) binary and pins the
//! exact package version it was resolved from.
//!
//! Mirrors `node_modules/typescript/lib/getExePath.js`'s "installed package"
//! branch: the root `typescript` package's `package.json` supplies the
//! declared bin name (`tsc`, since the root package is named `typescript`,
//! not `tsgo`) and version; a sibling optional-dependency platform package
//! (`@typescript/typescript-<platform>-<arch>`) supplies the actual native
//! binary under its `lib/` directory. Unlike the JS resolver (which uses
//! Node's module resolution, following pnpm's `.pnpm` content-addressed
//! store transparently), this Rust port has no module resolver, so it
//! checks the two on-disk shapes that resolution can produce: a pnpm
//! `.pnpm/<name>+<version>/node_modules/<name>` store entry, and a plain
//! hoisted `node_modules/<name>` directory (npm/yarn, or a pnpm shamefully-
//! hoisted install).

use std::fs;
use std::path::{Path, PathBuf};

/// Environment variable that overrides binary discovery entirely. When set,
/// its value is used verbatim as the path to the `tsc`/`tsgo` executable —
/// no `node_modules` lookup is performed. Existence is still checked so a
/// stale override fails fast with a clear message rather than at spawn time.
pub const BINARY_OVERRIDE_ENV: &str = "URDIRA_TSGO_BINARY";

/// Identifies the exact tsgo build a `TsgoClient` is pinned to: the root
/// `typescript` npm package's version (the wire protocol has no version
/// negotiation of its own — see `TsgoClient::PROTOCOL_VERSION` — so this is
/// the only external handle on "which build produced this binary") and the
/// resolved platform package name, recorded for diagnostics.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TsgoVersion {
    /// `version` field of `node_modules/typescript/package.json`.
    pub typescript_package_version: String,
    /// e.g. `@typescript/typescript-darwin-arm64`.
    pub platform_package_name: String,
}

/// A resolved tsgo binary: its filesystem path plus the version it was
/// resolved from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TsgoBinary {
    pub path: PathBuf,
    pub version: TsgoVersion,
}

#[derive(Debug)]
pub enum DiscoverError {
    Io {
        path: PathBuf,
        source: std::io::Error,
    },
    Json {
        path: PathBuf,
        source: serde_json::Error,
    },
    MalformedPackageJson {
        path: PathBuf,
        reason: String,
    },
    UnsupportedPlatform {
        os: &'static str,
        arch: &'static str,
    },
    NotFound {
        candidates: Vec<PathBuf>,
    },
    OverrideNotFound {
        path: PathBuf,
    },
}

impl std::fmt::Display for DiscoverError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            DiscoverError::Io { path, source } => {
                write!(f, "failed to read {}: {source}", path.display())
            }
            DiscoverError::Json { path, source } => {
                write!(f, "failed to parse {} as JSON: {source}", path.display())
            }
            DiscoverError::MalformedPackageJson { path, reason } => {
                write!(f, "{}: {reason}", path.display())
            }
            DiscoverError::UnsupportedPlatform { os, arch } => {
                write!(
                    f,
                    "tsgo has no known platform package for os={os} arch={arch}"
                )
            }
            DiscoverError::NotFound { candidates } => {
                write!(
                    f,
                    "tsgo binary not found; checked: {}",
                    candidates
                        .iter()
                        .map(|p| p.display().to_string())
                        .collect::<Vec<_>>()
                        .join(", ")
                )
            }
            DiscoverError::OverrideNotFound { path } => {
                write!(
                    f,
                    "{} points to a nonexistent file (from {BINARY_OVERRIDE_ENV})",
                    path.display()
                )
            }
        }
    }
}

impl std::error::Error for DiscoverError {}

#[derive(serde::Deserialize)]
struct PackageJson {
    name: String,
    version: String,
    #[serde(default)]
    bin: serde_json::Value,
}

/// Node's `process.platform` string for the platform this Rust binary is
/// running on, or `None` if there is no tsgo platform package for it.
fn node_platform() -> Option<&'static str> {
    match std::env::consts::OS {
        "macos" => Some("darwin"),
        "linux" => Some("linux"),
        "windows" => Some("win32"),
        "freebsd" => Some("freebsd"),
        "openbsd" => Some("openbsd"),
        "netbsd" => Some("netbsd"),
        "aix" => Some("aix"),
        "solaris" => Some("sunos"),
        _ => None,
    }
}

/// Node's `process.arch` string for the platform this Rust binary is
/// running on, or `None` if there is no tsgo platform package for it.
fn node_arch() -> Option<&'static str> {
    match std::env::consts::ARCH {
        "aarch64" => Some("arm64"),
        "x86_64" => Some("x64"),
        "arm" => Some("arm"),
        "riscv64" => Some("riscv64"),
        "powerpc64" => Some("ppc64"),
        "s390x" => Some("s390x"),
        "loongarch64" => Some("loong64"),
        "mips64" => Some("mips64el"),
        _ => None,
    }
}

fn read_package_json(path: &Path) -> Result<PackageJson, DiscoverError> {
    let text = fs::read_to_string(path).map_err(|source| DiscoverError::Io {
        path: path.to_path_buf(),
        source,
    })?;
    serde_json::from_str(&text).map_err(|source| DiscoverError::Json {
        path: path.to_path_buf(),
        source,
    })
}

/// Derives the expected bin name the way `getExePath.js` does: the root
/// package's own name, minus a scope, is `"typescript"` for the real
/// `typescript` npm package (bin name `tsc`) or anything else (bin name
/// `tsgo`, for a future from-source or renamed distribution). Validates
/// that `bin` declares exactly that one entry, matching the upstream
/// resolver's own defensive check (so a future package restructuring is
/// caught here rather than silently resolving the wrong binary).
fn expected_bin_name(pkg: &PackageJson) -> Result<&'static str, String> {
    let base_name = pkg.name.rsplit('/').next().unwrap_or(&pkg.name);
    let expected = if base_name == "typescript" {
        "tsc"
    } else {
        "tsgo"
    };
    let bin_names: Vec<&str> = match &pkg.bin {
        serde_json::Value::Object(map) => map.keys().map(String::as_str).collect(),
        _ => Vec::new(),
    };
    if bin_names.len() != 1 || bin_names[0] != expected {
        return Err(format!(
            "expected {} to declare exactly one bin entry named {expected}, found {bin_names:?}",
            pkg.name
        ));
    }
    Ok(expected)
}

/// Resolves the tsgo binary for `repo_root`, an `URDIRA_TSGO_BINARY`
/// override, or an error explaining why neither worked. Re-derives the
/// pnpm store layout by hand (see module docs) rather than invoking Node's
/// module resolver, so it is exercised even without a Node process.
pub fn discover(repo_root: &Path) -> Result<TsgoBinary, DiscoverError> {
    if let Ok(override_path) = std::env::var(BINARY_OVERRIDE_ENV) {
        let path = PathBuf::from(override_path);
        if !path.is_file() {
            return Err(DiscoverError::OverrideNotFound { path });
        }
        // The override skips package.json discovery entirely, so the
        // version is reported as unknown rather than guessed.
        return Ok(TsgoBinary {
            path,
            version: TsgoVersion {
                typescript_package_version: "unknown (URDIRA_TSGO_BINARY override)".to_string(),
                platform_package_name: "unknown (URDIRA_TSGO_BINARY override)".to_string(),
            },
        });
    }

    let root_package_json = repo_root.join("node_modules/typescript/package.json");
    let root_pkg = read_package_json(&root_package_json)?;
    expected_bin_name(&root_pkg).map_err(|reason| DiscoverError::MalformedPackageJson {
        path: root_package_json.clone(),
        reason,
    })?;
    let bin_name = if root_pkg.name.rsplit('/').next().unwrap_or(&root_pkg.name) == "typescript" {
        "tsc"
    } else {
        "tsgo"
    };

    let os = node_platform().ok_or(DiscoverError::UnsupportedPlatform {
        os: std::env::consts::OS,
        arch: std::env::consts::ARCH,
    })?;
    let arch = node_arch().ok_or(DiscoverError::UnsupportedPlatform {
        os: std::env::consts::OS,
        arch: std::env::consts::ARCH,
    })?;

    let platform_package_name = format!("@typescript/typescript-{os}-{arch}");
    let version = &root_pkg.version;
    let exe_suffix = if cfg!(windows) { ".exe" } else { "" };

    // pnpm content-addressed store: node_modules/.pnpm/<name-with-/-as-+>@<version>/node_modules/<name>/lib/<bin>
    let pnpm_dir_name = format!("{}@{version}", platform_package_name.replace('/', "+"));
    let pnpm_candidate = repo_root
        .join("node_modules/.pnpm")
        .join(&pnpm_dir_name)
        .join("node_modules")
        .join(&platform_package_name)
        .join("lib")
        .join(format!("{bin_name}{exe_suffix}"));

    // Plain hoisted layout: node_modules/<name>/lib/<bin>
    let hoisted_candidate = repo_root
        .join("node_modules")
        .join(&platform_package_name)
        .join("lib")
        .join(format!("{bin_name}{exe_suffix}"));

    for candidate in [&pnpm_candidate, &hoisted_candidate] {
        if candidate.is_file() {
            return Ok(TsgoBinary {
                path: candidate.clone(),
                version: TsgoVersion {
                    typescript_package_version: version.clone(),
                    platform_package_name,
                },
            });
        }
    }

    Err(DiscoverError::NotFound {
        candidates: vec![pnpm_candidate, hoisted_candidate],
    })
}

/// C.4: the test-only counterpart to [`discover`] that PANICS (with
/// guidance) instead of silently skipping when a tsgo binary is not
/// discoverable. Every test in this crate (and `urdira-indexing-worker`'s
/// residual tests) that needs a real tsgo child process used to do `let
/// Some(tsgo) = discover_binary() else { return }` -- a test that "needs
/// tsgo" but simply is not run at all whenever the binary happens to be
/// missing (a worktree without `node_modules`, `URDIRA_TSGO_BINARY` unset)
/// reports as `test ... ok` either way, so a real regression in the tsgo
/// RPC path can silently stop being exercised without any signal in
/// `cargo test`'s own summary line (see docs/evidence/2026-09-05-v4-
/// frentes-1-2-3-4-reopen-references-analyze-residual.md §11's "Trampas"
/// section, discovered live during that session).
///
/// Callers pair this with `#[ignore = "requires tsgo binary (set
/// URDIRA_TSGO_BINARY)"]` on the test itself: `cargo test` without the
/// binary available shows the test as `ignored` (an honest, visible
/// signal, distinct from `ok`), and `cargo test -- --ignored` with
/// `URDIRA_TSGO_BINARY` set (or a real `node_modules` in `repo_root`)
/// actually runs it, panicking loudly if discovery STILL fails (a
/// misconfigured invocation, not a legitimate skip).
pub fn discover_for_tests(repo_root: &Path) -> TsgoBinary {
    discover(repo_root).unwrap_or_else(|e| {
        panic!(
            "tsgo binary not discoverable: {e}. Set URDIRA_TSGO_BINARY=<path to lib/tsc> or run \
             pnpm install"
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    fn repo_root() -> PathBuf {
        // CARGO_MANIFEST_DIR is crates/urdira-tsgo-client; the repo root is
        // two levels up.
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .canonicalize()
            .expect("repo root should exist")
    }

    /// `BINARY_OVERRIDE_ENV` is process-global state, but Rust's default
    /// test harness runs every test in this file's `mod tests` as separate
    /// THREADS within the SAME process — `discovers_the_real_binary_in_this_
    /// repo` and `override_env_wins_and_is_validated` mutate the same env
    /// var, so without serialization they can race (one test's `set_var`/
    /// `remove_var` landing between the other's `remove_var` and its own
    /// `discover` call), observed live as an intermittent failure of
    /// `discovers_the_real_binary_in_this_repo` under concurrent load
    /// (P1-D-e's own evidence doc, `docs/evidence/
    /// 2026-09-04-v4-p1d-e-residual-rpc.md`). Every test that touches this
    /// env var must hold this lock for the full duration of its
    /// set/remove/`discover` sequence.
    static ENV_LOCK: Mutex<()> = Mutex::new(());

    #[test]
    fn discovers_the_real_binary_in_this_repo() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        // SAFETY: serialized against every other test in this module that
        // touches `BINARY_OVERRIDE_ENV`, via `ENV_LOCK` above.
        unsafe {
            std::env::remove_var(BINARY_OVERRIDE_ENV);
        }
        let root = repo_root();
        if !root.join("node_modules/typescript/package.json").is_file() {
            eprintln!("skipping: node_modules/typescript not installed");
            return;
        }
        let resolved = discover(&root).expect("discovery should succeed in this repo");
        assert!(
            resolved.path.is_file(),
            "resolved path must exist: {}",
            resolved.path.display()
        );
        assert_eq!(resolved.version.typescript_package_version, "7.0.2");
        assert!(
            resolved
                .version
                .platform_package_name
                .starts_with("@typescript/typescript-")
        );
    }

    #[test]
    fn override_env_wins_and_is_validated() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let root = repo_root();
        let missing = root.join("does-not-exist-tsgo-binary");
        // SAFETY: serialized against every other test in this module that
        // touches `BINARY_OVERRIDE_ENV`, via `ENV_LOCK` (see that item's
        // doc comment).
        unsafe {
            std::env::set_var(BINARY_OVERRIDE_ENV, &missing);
        }
        let result = discover(&root);
        unsafe {
            std::env::remove_var(BINARY_OVERRIDE_ENV);
        }
        assert!(matches!(
            result,
            Err(DiscoverError::OverrideNotFound { .. })
        ));
    }

    #[test]
    fn expected_bin_name_rejects_mismatched_bin_map() {
        let pkg = PackageJson {
            name: "typescript".to_string(),
            version: "7.0.2".to_string(),
            bin: serde_json::json!({ "tsgo": "./bin/tsgo" }),
        };
        assert!(expected_bin_name(&pkg).is_err());
    }

    #[test]
    fn expected_bin_name_accepts_the_real_shape() {
        let pkg = PackageJson {
            name: "typescript".to_string(),
            version: "7.0.2".to_string(),
            bin: serde_json::json!({ "tsc": "./bin/tsc" }),
        };
        assert_eq!(expected_bin_name(&pkg).unwrap(), "tsc");
    }
}
