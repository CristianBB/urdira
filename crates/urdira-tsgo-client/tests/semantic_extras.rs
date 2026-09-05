//! Integration tests for decision 28's "inferred types + compiler
//! diagnostics" task (`crate::semantic_extras`, wired into
//! `crate::residual_pass::ResidualPass` via `ResidualPassConfig::
//! fetch_semantics`) — against the REAL tsgo binary. C.4 (2026-09-05):
//! every test here is `#[ignore = "requires tsgo binary (set
//! URDIRA_TSGO_BINARY)"]` and calls `binary::discover_for_tests`, which
//! panics (with guidance) rather than silently skipping when the binary is
//! not discoverable.
//!
//! Covers:
//! - An exported top-level function and an exported class get a checker
//!   type (`typeToString`'s own text, unbounded).
//! - An exported class's members (a method and a property) ALSO get typed —
//!   v3's "a member's parent is exported" rule.
//! - A NOT-exported top-level declaration gets no type at all.
//! - A deliberate type error (`const bad: number = "nope";`) produces a
//!   `jsts:compiler_diagnostic`-shaped diagnostic site, carrying the real
//!   TS2322 compiler code.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use urdira_tsgo_client::binary::{self, TsgoBinary};
use urdira_tsgo_client::residual_pass::{ResidualPass, ResidualPassConfig, WindowPlan};
use urdira_tsgo_client::resolver::PendingSite;
use urdira_tsgo_client::virtual_fs::{MapFs, VirtualFs};

const VIRTUAL_ROOT: &str = "/workspace";
const CONFIG_PATH: &str = "/workspace/__semantic_extras_test__.json";

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .expect("repo root should exist")
}

fn lib_root_dir(binary: &TsgoBinary) -> String {
    binary
        .path
        .parent()
        .expect("tsgo binary path should have a parent directory")
        .to_string_lossy()
        .replace('\\', "/")
}

fn compiler_options() -> serde_json::Value {
    serde_json::json!({
        "module": "ESNext",
        "moduleResolution": "Bundler",
        "target": "ES2022",
        "strict": false,
        "skipLibCheck": true,
        "allowJs": true,
        "checkJs": true,
    })
}

fn virtual_path(name: &str) -> String {
    format!("{VIRTUAL_ROOT}/{name}")
}

const A_TS: &str = r#"export function add(a: number, b: number): number {
  return a + b;
}

function helper(): string {
  return "not exported";
}

export class Widget {
  count = 0;
  describe(): string {
    return `widget ${this.count}`;
  }
}

const bad: number = "nope";
"#;

fn run_semantics(
    text: &'static str,
) -> (
    Vec<urdira_tsgo_client::residual_pass::InferredTypeResult>,
    Vec<urdira_tsgo_client::residual_pass::DiagnosticResult>,
) {
    let tsgo = binary::discover_for_tests(&repo_root());
    let mut fs = MapFs::new();
    let owner = virtual_path("a.ts");
    fs.insert(owner.clone(), text);
    fs.insert(virtual_path("package.json"), r#"{"type":"module"}"#);
    let fs: Arc<dyn VirtualFs> = Arc::new(fs);

    let plan = WindowPlan::build(std::slice::from_ref(&owner), 512);
    let pending_by_owner: BTreeMap<String, Vec<PendingSite>> = BTreeMap::new();
    let config = ResidualPassConfig {
        lib_roots: vec![lib_root_dir(&tsgo)],
        binary: tsgo,
        root: VIRTUAL_ROOT.to_string(),
        project_config_path: CONFIG_PATH.to_string(),
        compiler_options: compiler_options(),
        fetch_semantics: true,
        deadline: None,
    };
    let (_, stats) = ResidualPass::run_instrumented(&plan, 1, &pending_by_owner, fs, &config)
        .expect("residual pass should succeed");
    (stats.types, stats.diagnostics)
}

#[test]
#[ignore = "requires tsgo binary (set URDIRA_TSGO_BINARY)"]
fn exported_function_and_class_members_are_typed_but_unexported_is_not() {
    let (types, _diagnostics) = run_semantics(A_TS);
    assert!(!types.is_empty(), "expected at least one typed declaration");

    let owner = virtual_path("a.ts");
    let names_and_starts: Vec<(i32, &str)> = types
        .iter()
        .map(|t| (t.site.name_start_utf16, t.site.type_text.as_str()))
        .collect();
    assert!(
        types.iter().all(|t| t.owner_path == owner),
        "every typed site should carry the owner path"
    );

    // `add`'s own type is a function signature -- exact text is a tsgo
    // formatting detail this test does not pin down, only that SOME type
    // text was produced.
    let add_start = A_TS.find("add").unwrap();
    let add_start_utf16 = A_TS[..add_start].encode_utf16().count() as i32;
    assert!(
        names_and_starts
            .iter()
            .any(|(start, _)| *start == add_start_utf16),
        "exported function `add` should be typed; got {names_and_starts:?}"
    );

    // `helper` is NOT exported -- must not appear at all.
    let helper_start = A_TS.find("helper").unwrap();
    let helper_start_utf16 = A_TS[..helper_start].encode_utf16().count() as i32;
    assert!(
        names_and_starts
            .iter()
            .all(|(start, _)| *start != helper_start_utf16),
        "unexported function `helper` must not be typed; got {names_and_starts:?}"
    );

    // `Widget` itself, plus its member `count` and `describe`, are all
    // exported (member's parent -- the class -- is exported).
    let widget_start = A_TS.find("Widget").unwrap();
    let widget_start_utf16 = A_TS[..widget_start].encode_utf16().count() as i32;
    assert!(
        names_and_starts
            .iter()
            .any(|(start, _)| *start == widget_start_utf16),
        "exported class `Widget` should be typed; got {names_and_starts:?}"
    );

    let count_start = A_TS.find("count = 0").unwrap();
    let count_start_utf16 = A_TS[..count_start].encode_utf16().count() as i32;
    assert!(
        names_and_starts
            .iter()
            .any(|(start, _)| *start == count_start_utf16),
        "exported class member `count` should be typed; got {names_and_starts:?}"
    );

    let describe_start = A_TS.find("describe").unwrap();
    let describe_start_utf16 = A_TS[..describe_start].encode_utf16().count() as i32;
    assert!(
        names_and_starts
            .iter()
            .any(|(start, _)| *start == describe_start_utf16),
        "exported class member `describe` should be typed; got {names_and_starts:?}"
    );

    let describe_site = types
        .iter()
        .find(|t| t.site.name_start_utf16 == describe_start_utf16)
        .expect("describe should be typed");
    assert_eq!(
        describe_site.site.display_name, "Widget.describe",
        "a member's display_name should be \"{{Container}}.{{member}}\", matching analyzer.ts's \
         `${{parent.qualified_name ?? parent.name}}.${{name}}`"
    );

    let add_site = types
        .iter()
        .find(|t| t.site.name_start_utf16 == add_start_utf16)
        .expect("add should be typed");
    assert_eq!(
        add_site.site.display_name, "add",
        "a top-level declaration's display_name is its own bare name"
    );
}

const NAMESPACE_TS: &str = r#"export namespace Utils {
  export function double(n: number): number {
    return n * 2;
  }
  export const factor = 2;
  function hidden(): void {}
}
"#;

/// F4 4.4: an exported `namespace`'s own exported members (a function and a
/// `const`) get typed with a `"{Namespace}.{member}"` `display_name`, the
/// same convention an exported class's members already use — and a
/// NOT-exported member inside the namespace is excluded, mirroring the
/// class-member test above.
#[test]
#[ignore = "requires tsgo binary (set URDIRA_TSGO_BINARY)"]
fn namespace_members_are_typed_with_namespace_qualified_display_name() {
    let (types, _diagnostics) = run_semantics(NAMESPACE_TS);
    assert!(!types.is_empty(), "expected at least one typed declaration");
    let names_and_starts: Vec<(i32, &str)> = types
        .iter()
        .map(|t| (t.site.name_start_utf16, t.site.display_name.as_str()))
        .collect();

    let double_start = NAMESPACE_TS.find("double").unwrap();
    let double_start_utf16 = NAMESPACE_TS[..double_start].encode_utf16().count() as i32;
    let double_site = types
        .iter()
        .find(|t| t.site.name_start_utf16 == double_start_utf16)
        .unwrap_or_else(|| {
            panic!("expected namespace member `double` to be typed; got {names_and_starts:?}")
        });
    assert_eq!(double_site.site.display_name, "Utils.double");

    let factor_start = NAMESPACE_TS.find("factor").unwrap();
    let factor_start_utf16 = NAMESPACE_TS[..factor_start].encode_utf16().count() as i32;
    let factor_site = types
        .iter()
        .find(|t| t.site.name_start_utf16 == factor_start_utf16)
        .unwrap_or_else(|| {
            panic!("expected namespace member `factor` to be typed; got {names_and_starts:?}")
        });
    assert_eq!(factor_site.site.display_name, "Utils.factor");

    let hidden_start = NAMESPACE_TS.find("hidden").unwrap();
    let hidden_start_utf16 = NAMESPACE_TS[..hidden_start].encode_utf16().count() as i32;
    assert!(
        names_and_starts
            .iter()
            .all(|(start, _)| *start != hidden_start_utf16),
        "unexported namespace member `hidden` must not be typed; got {names_and_starts:?}"
    );
}

#[test]
#[ignore = "requires tsgo binary (set URDIRA_TSGO_BINARY)"]
fn deliberate_type_error_produces_a_compiler_diagnostic() {
    let (_types, diagnostics) = run_semantics(A_TS);
    assert!(
        diagnostics.iter().any(|d| d.site.compiler_code == 2322),
        "expected a TS2322 (type not assignable) diagnostic for `const bad: number = \"nope\"`; \
         got codes {:?}",
        diagnostics
            .iter()
            .map(|d| d.site.compiler_code)
            .collect::<Vec<_>>()
    );
    assert!(
        diagnostics
            .iter()
            .all(|d| d.owner_path == virtual_path("a.ts")),
        "every diagnostic should carry the owner path"
    );
}

#[test]
#[ignore = "requires tsgo binary (set URDIRA_TSGO_BINARY)"]
fn fetch_semantics_false_collects_no_types_or_diagnostics() {
    let tsgo = binary::discover_for_tests(&repo_root());
    let mut fs = MapFs::new();
    let owner = virtual_path("a.ts");
    fs.insert(owner.clone(), A_TS);
    fs.insert(virtual_path("package.json"), r#"{"type":"module"}"#);
    let fs: Arc<dyn VirtualFs> = Arc::new(fs);
    let plan = WindowPlan::build(std::slice::from_ref(&owner), 512);
    let pending_by_owner: BTreeMap<String, Vec<PendingSite>> = BTreeMap::new();
    let config = ResidualPassConfig {
        lib_roots: vec![lib_root_dir(&tsgo)],
        binary: tsgo,
        root: VIRTUAL_ROOT.to_string(),
        project_config_path: CONFIG_PATH.to_string(),
        compiler_options: compiler_options(),
        fetch_semantics: false,
        deadline: None,
    };
    let (_, stats) = ResidualPass::run_instrumented(&plan, 1, &pending_by_owner, fs, &config)
        .expect("residual pass should succeed");
    assert!(stats.types.is_empty());
    assert!(stats.diagnostics.is_empty());
}
