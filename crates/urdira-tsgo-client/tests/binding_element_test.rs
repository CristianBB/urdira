//! F4 4.4 + revision fix (2026-09-05): `RemoteSourceFile::name_start`'s
//! `BindingElement` handling (`crate::node::syntax_kind::BINDING_ELEMENT`)
//! — against the REAL tsgo binary (skips, printing why, rather than
//! failing, when it is not discoverable, matching `tests/oracle_resolve
//! .rs`'s own policy).
//!
//! Covers every shape `name_start`'s own doc comment documents:
//! - `{ plain }` — a plain (non-renamed, no default) element resolves to
//!   its own identifier.
//! - `{ propB: renamedSimple }` — a renamed element resolves to the LOCAL
//!   binding name (`renamedSimple`), never the property name (`propB`).
//! - `{ withDefault = defaultRef }` — a default-value initializer that is
//!   ITSELF a bare identifier reference must not be picked over the real
//!   name (the bug the revision fix closes: an earlier "last identifier
//!   child wins" cut of this fix returned `defaultRef`'s position here).
//! - `{ propD: renamedWithDefault = defaultRef }` — rename AND an
//!   identifier-shaped default together: still resolves to the local name.
//! - `{ nested: { inner } }` — the OUTER element's `name` is itself a
//!   binding pattern (nested destructuring), not an Identifier: falls back
//!   to the propertyName's own position (`nested`), not a crash or `None`;
//!   the INNER element (`inner`) resolves normally, exactly like `{ plain
//!   }` (no rename, no default).

use std::path::{Path, PathBuf};
use std::sync::Arc;

use urdira_tsgo_client::binary::{self, TsgoBinary};
use urdira_tsgo_client::client::TsgoClient;
use urdira_tsgo_client::node::{NodeHandle, RemoteSourceFile, syntax_kind};
use urdira_tsgo_client::proto::UpdateSnapshotParams;
use urdira_tsgo_client::virtual_fs::{LayeredFs, MapFs, OverlayFs, VirtualFs};

const VIRTUAL_ROOT: &str = "/workspace";
const CONFIG_PATH: &str = "/workspace/__binding_element_test__.json";
const A_TS: &str = r#"const defaultRef = 5;
export const { plain } = { plain: 1 };
export const { propB: renamedSimple } = { propB: 2 };
export const { withDefault = defaultRef } = { withDefault: 3 };
export const { propD: renamedWithDefault = defaultRef } = { propD: 4 };
export const { nested: { inner } } = { nested: { inner: 5 } };
"#;

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

/// Every `BindingElement` node index in `file`, found by a plain linear
/// scan over every node index (simpler and just as correct as a tree walk
/// for this purpose: `node_start` reads a node's own `pos` field directly,
/// independent of tree structure).
fn binding_element_indices(file: &RemoteSourceFile) -> Vec<usize> {
    (0..file.node_count())
        .filter(|&i| file.kind(i) == syntax_kind::BINDING_ELEMENT)
        .collect()
}

#[test]
fn binding_element_name_start_covers_plain_renamed_default_and_nested_shapes() {
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

    // -- Exported bindings, via the SAME getExportsOfModule path a real
    // residual pass uses (`crate::semantic_extras::exported_declaration_
    // indices`). --
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
    assert_eq!(
        exports.len(),
        5,
        "expected plain, renamedSimple, withDefault, renamedWithDefault, inner; got {:?}",
        exports.iter().map(|s| &s.name).collect::<Vec<_>>()
    );

    let name_start_of = |symbol_name: &str| -> i32 {
        let symbol = exports
            .iter()
            .find(|s| s.name == symbol_name)
            .unwrap_or_else(|| panic!("export {symbol_name:?} not found"));
        let handle_str = symbol
            .value_declaration
            .clone()
            .expect("each export should have a value_declaration");
        let handle = NodeHandle::parse(&handle_str).expect("valid node handle");
        assert_eq!(
            owner_file.kind(handle.index as usize),
            syntax_kind::BINDING_ELEMENT,
            "getExportsOfModule should point directly at the BindingElement for {symbol_name:?}"
        );
        owner_file
            .name_start(handle.index as usize, &text)
            .unwrap_or_else(|| panic!("name_start should resolve for {symbol_name:?}"))
    };

    // `{ plain }`: plain element, no rename, no default.
    assert_eq!(
        name_start_of("plain"),
        find_utf16_span(A_TS, "plain", 1),
        "plain destructured binding should resolve to its own identifier position"
    );

    // `{ propB: renamedSimple }`: renamed, no default.
    let renamed_simple_start = name_start_of("renamedSimple");
    assert_ne!(
        renamed_simple_start,
        find_utf16_span(A_TS, "propB", 1),
        "must NOT resolve to the property name `propB`'s position"
    );
    assert_eq!(
        renamed_simple_start,
        find_utf16_span(A_TS, "renamedSimple", 1),
        "renamed destructured export should resolve to its own local name's position"
    );

    // `{ withDefault = defaultRef }`: default value that is ITSELF a bare
    // identifier reference -- must resolve to `withDefault`, not
    // `defaultRef` (the bug the revision fix closes).
    let with_default_start = name_start_of("withDefault");
    assert_ne!(
        with_default_start,
        find_utf16_span(A_TS, "defaultRef", 2),
        "must NOT resolve to the identifier-shaped default value's position"
    );
    assert_eq!(
        with_default_start,
        find_utf16_span(A_TS, "withDefault", 1),
        "a default value that is a bare identifier reference must not be picked over the name"
    );

    // `{ propD: renamedWithDefault = defaultRef }`: rename AND an
    // identifier-shaped default together.
    let renamed_with_default_start = name_start_of("renamedWithDefault");
    assert_ne!(
        renamed_with_default_start,
        find_utf16_span(A_TS, "propD", 1),
        "must NOT resolve to the property name `propD`'s position"
    );
    assert_ne!(
        renamed_with_default_start,
        find_utf16_span(A_TS, "defaultRef", 3),
        "must NOT resolve to the identifier-shaped default value's position"
    );
    assert_eq!(
        renamed_with_default_start,
        find_utf16_span(A_TS, "renamedWithDefault", 1),
        "rename + identifier-shaped default should still resolve to the local binding name"
    );

    // `{ nested: { inner } }`: the INNER element (`inner`) is exported and
    // behaves exactly like a plain element.
    assert_eq!(
        name_start_of("inner"),
        find_utf16_span(A_TS, "inner", 1),
        "the nested (nameable) inner binding should resolve to its own identifier position"
    );

    // The OUTER element (`nested: { ... }`) is never itself an exported
    // symbol (its own "name" is a binding PATTERN, not an Identifier) --
    // located directly by node position instead of via getExportsOfModule.
    let nested_start = find_utf16_span(A_TS, "nested", 1);
    let outer_index = binding_element_indices(&owner_file)
        .into_iter()
        .find(|&i| owner_file.node_start(i, &text) == nested_start)
        .expect("the outer `nested: {...}` BindingElement should exist in the AST");
    assert_eq!(
        owner_file.name_start(outer_index, &text),
        Some(nested_start),
        "a nested-destructuring rename whose own `name` is a binding pattern (not an \
         Identifier) must fall back to the propertyName's own position, not crash or return None"
    );

    let _ = client.shutdown();
}
