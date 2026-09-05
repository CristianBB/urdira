//! F4 4.4: `RemoteSourceFile::name_start`'s `BindingElement` handling
//! (`crate::node::syntax_kind::BINDING_ELEMENT`) — against the REAL tsgo
//! binary (skips, printing why, rather than failing, when it is not
//! discoverable, matching `tests/oracle_resolve.rs`'s own policy).
//!
//! Verifies, for `export const { a, b: renamed } = { a: 1, b: 2 };`:
//! - `getExportsOfModule` points BOTH exported bindings' `value_declaration`
//!   directly at a `BindingElement` node (not the enclosing
//!   `VariableDeclaration`) — the precondition this whole fix exists for.
//! - A plain (non-renamed) element's `name_start` is its own identifier's
//!   position (`a`).
//! - A renamed element's `name_start` is the LOCAL binding name's position
//!   (`renamed`), not the property name's (`b`) — the actual bug this task
//!   fixes (confirmed live before the fix: it returned `b`'s position).

use std::path::{Path, PathBuf};
use std::sync::Arc;

use urdira_tsgo_client::binary::{self, TsgoBinary};
use urdira_tsgo_client::client::TsgoClient;
use urdira_tsgo_client::node::{NodeHandle, syntax_kind};
use urdira_tsgo_client::proto::UpdateSnapshotParams;
use urdira_tsgo_client::virtual_fs::{LayeredFs, MapFs, OverlayFs, VirtualFs};

const VIRTUAL_ROOT: &str = "/workspace";
const CONFIG_PATH: &str = "/workspace/__binding_element_test__.json";
const A_TS: &str = "export const { a, b: renamed } = { a: 1, b: 2 };\n";

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .expect("repo root should exist")
}

fn discover_binary() -> Option<TsgoBinary> {
    match binary::discover(&repo_root()) {
        Ok(b) => Some(b),
        Err(e) => {
            eprintln!("skipping: tsgo binary not discoverable: {e}");
            None
        }
    }
}

fn lib_root_dir(binary: &TsgoBinary) -> String {
    binary
        .path
        .parent()
        .expect("tsgo binary path should have a parent directory")
        .to_string_lossy()
        .replace('\\', "/")
}

fn find_utf16_span(text: &str, needle: &str, occurrence: usize) -> i32 {
    let mut search_from = 0usize;
    let mut byte_start = None;
    for _ in 0..occurrence {
        let found = text[search_from..].find(needle).unwrap_or_else(|| {
            panic!("occurrence {occurrence} of {needle:?} not found in fixture text")
        });
        let absolute = search_from + found;
        byte_start = Some(absolute);
        search_from = absolute + needle.len();
    }
    let byte_start = byte_start.unwrap();
    text[..byte_start].encode_utf16().count() as i32
}

#[test]
fn renamed_destructured_export_resolves_to_the_local_binding_name_not_the_property_name() {
    let Some(tsgo) = discover_binary() else {
        return;
    };
    let mut fs = MapFs::new();
    let owner = format!("{VIRTUAL_ROOT}/a.ts");
    fs.insert(owner.clone(), A_TS);
    fs.insert(
        format!("{VIRTUAL_ROOT}/package.json"),
        r#"{"type":"module"}"#,
    );
    let fs: Arc<dyn VirtualFs> = Arc::new(fs);
    let overlay = Arc::new(OverlayFs::new(fs));
    let layered: Arc<LayeredFs> = Arc::new(LayeredFs::new(
        overlay.clone() as Arc<dyn VirtualFs>,
        vec![lib_root_dir(&tsgo)],
    ));
    let layered_dyn: Arc<dyn VirtualFs> = layered.clone();
    let mut client =
        TsgoClient::spawn(&tsgo, VIRTUAL_ROOT, Arc::clone(&layered_dyn)).expect("spawn");
    client.initialize().expect("initialize");

    let config_json = serde_json::json!({
        "compilerOptions": {
            "module": "ESNext",
            "moduleResolution": "Bundler",
            "target": "ES2022",
            "skipLibCheck": true,
        },
        "files": [owner.clone()],
    })
    .to_string();
    overlay.set(CONFIG_PATH.to_string(), config_json);
    let params = UpdateSnapshotParams {
        open_projects: vec![CONFIG_PATH.to_string()],
        ..Default::default()
    };
    let snapshot = client.update_snapshot(&params).expect("update_snapshot");
    let project = snapshot
        .projects
        .iter()
        .find(|p| p.config_file_name == CONFIG_PATH)
        .expect("project for this config")
        .id
        .clone();

    let owner_file = client
        .get_source_file(snapshot.snapshot, &project, &owner)
        .expect("get_source_file")
        .expect("owner file should exist");
    let text: Vec<u16> = A_TS.encode_utf16().collect();

    let module_symbol = client
        .get_symbol_at_location(
            snapshot.snapshot,
            &project,
            &NodeHandle::new(1, syntax_kind::SOURCE_FILE, owner.clone()),
        )
        .expect("get_symbol_at_location")
        .expect("file has a module symbol");
    let exports = client
        .get_exports_of_module(snapshot.snapshot, &project, module_symbol.id)
        .expect("get_exports_of_module");
    assert_eq!(exports.len(), 2, "expected exactly `a` and `renamed`");

    for symbol in &exports {
        let handle_str = symbol
            .value_declaration
            .clone()
            .expect("each export should have a value_declaration");
        let handle = NodeHandle::parse(&handle_str).expect("valid node handle");
        assert_eq!(
            owner_file.kind(handle.index as usize),
            syntax_kind::BINDING_ELEMENT,
            "getExportsOfModule should point directly at the BindingElement, not the \
             enclosing VariableDeclaration, for symbol {:?}",
            symbol.name
        );

        let name_start = owner_file
            .name_start(handle.index as usize, &text)
            .unwrap_or_else(|| {
                panic!(
                    "name_start should resolve for BindingElement {} (symbol {:?})",
                    handle.index, symbol.name
                )
            });

        if symbol.name == "a" {
            let expected = find_utf16_span(A_TS, "a", 1);
            assert_eq!(
                name_start, expected,
                "plain destructured `a` should resolve to its own identifier position"
            );
        } else if symbol.name == "renamed" {
            let expected = find_utf16_span(A_TS, "renamed", 1);
            let property_name_position = find_utf16_span(A_TS, "b", 1);
            assert_ne!(
                name_start, property_name_position,
                "must NOT resolve to the property name `b`'s position (the bug this task fixes)"
            );
            assert_eq!(
                name_start, expected,
                "renamed destructured export should resolve to `renamed`'s own position, not `b`'s"
            );
        } else {
            panic!("unexpected export name {:?}", symbol.name);
        }
    }

    let _ = client.shutdown();
}
