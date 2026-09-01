use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::env;
use std::fmt::Write as _;
use std::fs;
use std::io::{self, Read};
use std::path::{Component, Path, PathBuf};
use std::process::{Command, ExitCode, Stdio};

const CHECKSUMS_FILE: &str = "checksums.sha256";
const RELEASE_FILE: &str = "release.json";

fn compiled_target() -> &'static str {
    match (env::consts::OS, env::consts::ARCH) {
        ("macos", "aarch64") => "darwin-arm64",
        ("macos", "x86_64") => "darwin-x64",
        ("linux", "aarch64") => "linux-arm64-gnu",
        ("linux", "x86_64") => "linux-x64-gnu",
        ("windows", "x86_64") => "win32-x64",
        _ => "unsupported",
    }
}

fn safe_relative(path: &str) -> Option<PathBuf> {
    let candidate = Path::new(path);
    if candidate.is_absolute()
        || candidate
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
    {
        return None;
    }
    Some(candidate.to_path_buf())
}

fn parse_checksums(text: &str) -> Result<BTreeMap<PathBuf, String>, String> {
    let mut result = BTreeMap::new();
    for (index, line) in text.lines().enumerate() {
        if line.is_empty() {
            continue;
        }
        let (digest, path) = line
            .split_once("  ")
            .ok_or_else(|| format!("invalid checksum line {}", index + 1))?;
        let digest = digest.strip_prefix("sha256:").unwrap_or(digest);
        if digest.len() != 64 || !digest.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(format!("invalid SHA-256 on checksum line {}", index + 1));
        }
        let path = safe_relative(path)
            .ok_or_else(|| format!("unsafe checksum path on line {}", index + 1))?;
        if result.insert(path, digest.to_ascii_lowercase()).is_some() {
            return Err(format!("duplicate checksum path on line {}", index + 1));
        }
    }
    if result.is_empty() {
        return Err("checksum manifest is empty".to_owned());
    }
    Ok(result)
}

fn sha256_file(path: &Path) -> io::Result<String> {
    let mut file = fs::File::open(path)?;
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    let bytes = digest.finalize();
    let mut encoded = String::with_capacity(64);
    for byte in bytes {
        write!(&mut encoded, "{byte:02x}").expect("writing to String cannot fail");
    }
    Ok(encoded)
}

fn release_root() -> Result<PathBuf, String> {
    let executable = env::current_exe().map_err(|error| error.to_string())?;
    let bin = executable
        .parent()
        .ok_or_else(|| "launcher has no parent directory".to_owned())?;
    bin.parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| "launcher has no release root".to_owned())
}

fn runtime_entrypoint(root: &Path) -> PathBuf {
    root.join("app").join("dist").join("cli.js")
}

fn verify_release(root: &Path) -> Result<(), String> {
    let release_bytes = fs::read(root.join(RELEASE_FILE)).map_err(|error| error.to_string())?;
    let release: serde_json::Value =
        serde_json::from_slice(&release_bytes).map_err(|error| error.to_string())?;
    let target = release
        .get("target")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| "release metadata has no target".to_owned())?;
    if target != compiled_target() {
        return Err(format!(
            "release target {target} cannot run on {}",
            compiled_target()
        ));
    }

    let checksums = parse_checksums(
        &fs::read_to_string(root.join(CHECKSUMS_FILE)).map_err(|error| error.to_string())?,
    )?;
    for (relative, expected) in checksums {
        let actual = sha256_file(&root.join(&relative))
            .map_err(|error| format!("cannot verify {}: {error}", relative.display()))?;
        if actual != expected {
            return Err(format!("checksum mismatch for {}", relative.display()));
        }
    }
    Ok(())
}

fn run() -> Result<i32, String> {
    let root = release_root()?;
    verify_release(&root)?;
    let node = root
        .join("runtime")
        .join(if cfg!(windows) { "node.exe" } else { "node" });
    let entrypoint = runtime_entrypoint(&root);
    let status = Command::new(node)
        .arg(entrypoint)
        .args(env::args_os().skip(1))
        .env("URDIRA_NATIVE_ROOT", root.join("native"))
        .env("URDIRA_NATIVE_REQUIRED", "1")
        .env(
            "URDIRA_JSTS_WORKER_PATH",
            root.join("native").join(if cfg!(windows) {
                "urdira-jsts-syntax-worker.exe"
            } else {
                "urdira-jsts-syntax-worker"
            }),
        )
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .status()
        .map_err(|error| format!("cannot start the private Urdira runtime: {error}"))?;
    Ok(status.code().unwrap_or(1))
}

fn main() -> ExitCode {
    match run() {
        Ok(code) => ExitCode::from(u8::try_from(code).unwrap_or(1)),
        Err(message) => {
            eprintln!("[urdira] native launcher rejected the runtime: {message}");
            ExitCode::FAILURE
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{parse_checksums, runtime_entrypoint, safe_relative};
    use std::path::Path;

    #[test]
    fn rejects_unsafe_checksum_paths() {
        assert!(safe_relative("../runtime/node").is_none());
        assert!(safe_relative("/runtime/node").is_none());
        assert!(safe_relative("runtime/node").is_some());
    }

    #[test]
    fn parses_closed_checksum_manifest() {
        let digest = "a".repeat(64);
        let parsed = parse_checksums(&format!("{digest}  runtime/node\n")).unwrap();
        assert_eq!(parsed.len(), 1);
    }

    #[test]
    fn starts_the_cli_entrypoint_in_the_private_node_runtime() {
        assert_eq!(
            runtime_entrypoint(Path::new("release-root")),
            Path::new("release-root/app/dist/cli.js")
        );
    }
}
