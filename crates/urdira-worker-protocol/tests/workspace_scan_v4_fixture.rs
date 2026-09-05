//! Cross-language fixture round-trip for the v4 `WorkspaceScan`/`Queryable`/
//! `ScanCompleted` protocol shapes (task P2-2b). The JSON literals in
//! `tests/fixtures/workspace-scan-v4.json` are shared with
//! `tests/rust-protocol-v4.test.ts` (TS) so the two independently-typed
//! mirrors of these shapes cannot silently drift on a field name or `kind`
//! tag: this test decodes every entry into the Rust enum, the TS test
//! asserts the same object shapes it sends match the file byte-for-byte.

use urdira_worker_protocol::{
    ChangeKind, ChangedPath, IndexingCommand, IndexingEvent, ScanPriority, ScanRoots, ScanScope,
    ScanTimings,
};

const FIXTURE: &str = include_str!("fixtures/workspace-scan-v4.json");

fn fixture() -> serde_json::Value {
    serde_json::from_str(FIXTURE).expect("fixture is valid JSON")
}

#[test]
fn workspace_scan_full_fixture_decodes() {
    let value = fixture()["workspace_scan_full"].clone();
    let command: IndexingCommand = serde_json::from_value(value).expect("decodes");
    assert_eq!(
        command,
        IndexingCommand::WorkspaceScan {
            request_id: "request:scan-fixture-1".into(),
            workspace_id: "workspace:fixture".into(),
            workspace_root: "/tmp/urdira-fixture/source".into(),
            database_path: "/tmp/urdira-fixture/workspace.sqlite".into(),
            structural_root: "/tmp/urdira-fixture/structural".into(),
            cas_root: "/tmp/urdira-fixture/cas".into(),
            sidecar_root: "/tmp/urdira-fixture/sidecar".into(),
            scope: ScanScope::Full,
            registry_snapshot_id: "registry:fixture-1".into(),
            configuration_revision_id: "configuration:fixture-1".into(),
            resolution_lock_id: "resolution:fixture-1".into(),
            deadline_ms: Some(45_000),
            priority: ScanPriority::Interactive,
        }
    );
}

#[test]
fn workspace_scan_changed_fixture_decodes() {
    let value = fixture()["workspace_scan_changed"].clone();
    let command: IndexingCommand = serde_json::from_value(value).expect("decodes");
    assert_eq!(
        command,
        IndexingCommand::WorkspaceScan {
            request_id: "request:scan-fixture-2".into(),
            workspace_id: "workspace:fixture".into(),
            workspace_root: "/tmp/urdira-fixture/source".into(),
            database_path: "/tmp/urdira-fixture/workspace.sqlite".into(),
            structural_root: "/tmp/urdira-fixture/structural".into(),
            cas_root: "/tmp/urdira-fixture/cas".into(),
            sidecar_root: "/tmp/urdira-fixture/sidecar".into(),
            scope: ScanScope::Changed {
                paths: vec![
                    ChangedPath {
                        path: "src/a.ts".into(),
                        kind: ChangeKind::Modified,
                    },
                    ChangedPath {
                        path: "src/b.ts".into(),
                        kind: ChangeKind::Created,
                    },
                    ChangedPath {
                        path: "src/c.ts".into(),
                        kind: ChangeKind::Deleted,
                    },
                ],
            },
            registry_snapshot_id: "registry:fixture-1".into(),
            configuration_revision_id: "configuration:fixture-1".into(),
            resolution_lock_id: "resolution:fixture-1".into(),
            deadline_ms: None,
            priority: ScanPriority::Background,
        }
    );
}

#[test]
fn queryable_fixture_decodes() {
    let value = fixture()["queryable"].clone();
    let event: IndexingEvent = serde_json::from_value(value).expect("decodes");
    assert_eq!(
        event,
        IndexingEvent::Queryable {
            request_id: "request:scan-fixture-1".into(),
            operation_id: "request:scan-fixture-1".into(),
            generation: 1,
            manifest_path: "/tmp/urdira-fixture/structural/MANIFEST".into(),
            timings: ScanTimings {
                catalog_ms: Some(120),
                parse_ms: Some(900),
                resolve_ms: Some(200),
                materialize_ms: Some(1_500),
                write_ms: Some(2_600),
                fsync_ms: None,
                snapshot_ms: None,
                lexical_ms: None,
                total_ms: 5_320,
                ..Default::default()
            },
        }
    );
}

#[test]
fn scan_completed_fixture_decodes() {
    let value = fixture()["scan_completed"].clone();
    let event: IndexingEvent = serde_json::from_value(value).expect("decodes");
    assert_eq!(
        event,
        IndexingEvent::ScanCompleted {
            request_id: "request:scan-fixture-1".into(),
            operation_id: "request:scan-fixture-1".into(),
            generation: 1,
            snapshot_id: "snapshot:fixture-1".into(),
            roots: ScanRoots {
                records: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
                    .into(),
                dependency:
                    "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb".into(),
                graph: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
                    .into(),
                metric: "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
                    .into(),
            },
            timings: ScanTimings {
                catalog_ms: Some(120),
                parse_ms: Some(900),
                resolve_ms: Some(200),
                materialize_ms: Some(1_500),
                write_ms: Some(2_600),
                fsync_ms: Some(400),
                snapshot_ms: Some(80),
                lexical_ms: None,
                total_ms: 5_800,
                ..Default::default()
            },
        }
    );
}

#[test]
fn upgrade_completed_fixture_decodes() {
    let value = fixture()["upgrade_completed"].clone();
    let event: IndexingEvent = serde_json::from_value(value).expect("decodes");
    assert_eq!(
        event,
        IndexingEvent::UpgradeCompleted {
            request_id: "request:scan-fixture-1".into(),
            operation_id: "request:scan-fixture-1".into(),
            generation: 2,
            upgraded_sites: 731,
            external_sites: 42,
            unresolved_sites: 205,
            timings: ScanTimings {
                catalog_ms: None,
                parse_ms: None,
                resolve_ms: Some(2_300),
                materialize_ms: Some(180),
                write_ms: Some(90),
                fsync_ms: None,
                snapshot_ms: Some(30),
                lexical_ms: None,
                total_ms: 2_600,
                ..Default::default()
            },
            truncated: None,
            windows_done: None,
            windows_total: None,
        }
    );
}

/// Revision fix (2026-09-05): `UpgradeCompleted` with the new truncation
/// fields PRESENT -- round-trips through JSON with the exact same shape
/// `upgrade_completed_truncated` in the shared fixture file uses (and
/// `tests/rust-protocol-v4.test.ts` independently asserts against the same
/// file), complementing `upgrade_completed_fixture_decodes` above (which
/// covers the fields ABSENT/`None`, the backward-compat case for a sender
/// that predates this revision fix).
#[test]
fn upgrade_completed_truncated_fixture_decodes() {
    let value = fixture()["upgrade_completed_truncated"].clone();
    let event: IndexingEvent = serde_json::from_value(value).expect("decodes");
    assert_eq!(
        event,
        IndexingEvent::UpgradeCompleted {
            request_id: "request:scan-fixture-1".into(),
            operation_id: "request:scan-fixture-1".into(),
            generation: 2,
            upgraded_sites: 12,
            external_sites: 3,
            unresolved_sites: 1,
            timings: ScanTimings {
                resolve_ms: Some(20_000),
                materialize_ms: Some(50),
                write_ms: Some(20),
                snapshot_ms: Some(10),
                total_ms: 20_080,
                ..Default::default()
            },
            truncated: Some(true),
            windows_done: Some(3),
            windows_total: Some(10),
        }
    );
}
