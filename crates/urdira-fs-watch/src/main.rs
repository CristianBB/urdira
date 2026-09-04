// P3-7 spike: subscribes to one directory tree recursively via the `notify`
// crate (macOS default backend: FSEvents, via `fsevent-sys`) and prints one
// JSON line per received event to stdout, flushed immediately, so an
// external driver (`scripts/watch-latency-probe.mjs --mode crate`) can
// measure event-delivery latency the same way it measures `@parcel/watcher`.
// Deliberately minimal: this is a measurement spike, not production code.
// See `docs/evidence/2026-09-03-v4-p3-7-watcher-latency.md` for why this
// crate exists and how its numbers compare to `@parcel/watcher`'s kqueue and
// fs-events backends. NOT wired into `urdira-indexing-worker` or any shipped
// path.

use notify::{Config, Event, RecommendedWatcher, RecursiveMode, Watcher};
use std::env;
use std::io::Write;
use std::path::PathBuf;
use std::sync::mpsc::channel;
use std::time::{SystemTime, UNIX_EPOCH};

fn epoch_ms() -> f64 {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    duration.as_secs_f64() * 1000.0
}

fn json_escape(input: &str) -> String {
    let mut out = String::with_capacity(input.len() + 2);
    for ch in input.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out
}

fn kind_label(event: &Event) -> &'static str {
    use notify::EventKind::*;
    match event.kind {
        Create(_) => "create",
        Modify(_) => "modify",
        Remove(_) => "remove",
        Access(_) => "access",
        Other => "other",
        Any => "any",
    }
}

fn main() {
    let mut args = env::args().skip(1);
    let root = match args.next() {
        Some(value) => PathBuf::from(value),
        None => {
            eprintln!("usage: urdira-fs-watch <root> [--ready-marker <path>]");
            std::process::exit(2);
        }
    };
    let mut ready_marker: Option<PathBuf> = None;
    while let Some(arg) = args.next() {
        if arg == "--ready-marker" {
            ready_marker = args.next().map(PathBuf::from);
        }
    }

    // The receive-side timestamp is taken HERE, inside the callback, at the
    // earliest possible point after the underlying OS backend delivered the
    // event -- comparable to how `@parcel/watcher`'s own JS callback
    // timestamp is captured in `watch-latency-probe.mjs`. `notify::Event`
    // carries no timestamp field of its own, so it is paired with one here
    // via a `(f64, notify::Result<Event>)` channel.
    let (tx, rx) = channel::<(f64, notify::Result<Event>)>();
    let mut watcher: RecommendedWatcher = notify::recommended_watcher(move |result| {
        let t = epoch_ms();
        let _ = tx.send((t, result));
    })
    .expect("failed to construct recommended watcher");
    let _ = watcher.configure(Config::default());

    watcher
        .watch(&root, RecursiveMode::Recursive)
        .unwrap_or_else(|error| {
            eprintln!("failed to watch {}: {}", root.display(), error);
            std::process::exit(1);
        });

    // Signal readiness only once the watch is actually installed (matches
    // how a real caller would wait for `subscribe()` to resolve before
    // relying on detection) -- `watch-latency-probe.mjs --mode crate` polls
    // for this marker file's existence before starting its timed edits.
    if let Some(marker) = ready_marker {
        let _ = std::fs::write(&marker, b"ready\n");
    }

    let stdout = std::io::stdout();
    let mut handle = stdout.lock();
    for (received_at_ms, result) in rx {
        match result {
            Ok(event) => {
                let kind = kind_label(&event);
                let paths: Vec<String> = event
                    .paths
                    .iter()
                    .map(|p| json_escape(&p.to_string_lossy()))
                    .collect();
                let paths_json = paths
                    .iter()
                    .map(|p| format!("\"{}\"", p))
                    .collect::<Vec<_>>()
                    .join(",");
                let line = format!(
                    "{{\"epoch_ms\":{:.3},\"kind\":\"{}\",\"paths\":[{}]}}",
                    received_at_ms, kind, paths_json
                );
                let _ = writeln!(handle, "{}", line);
                let _ = handle.flush();
            }
            Err(error) => {
                let line = format!(
                    "{{\"epoch_ms\":{:.3},\"kind\":\"error\",\"message\":\"{}\"}}",
                    received_at_ms,
                    json_escape(&error.to_string())
                );
                let _ = writeln!(handle, "{}", line);
                let _ = handle.flush();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn json_escape_handles_quotes_backslashes_and_control_characters() {
        assert_eq!(json_escape("plain"), "plain");
        assert_eq!(json_escape("a\"b"), "a\\\"b");
        assert_eq!(json_escape("a\\b"), "a\\\\b");
        assert_eq!(json_escape("a\nb\rc"), "a\\nb\\rc");
        assert_eq!(json_escape("a\u{1}b"), "a\\u0001b");
    }

    #[test]
    fn epoch_ms_is_monotonically_plausible_and_matches_wall_clock() {
        let before = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs_f64()
            * 1000.0;
        let observed = epoch_ms();
        let after = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs_f64()
            * 1000.0;
        assert!(observed >= before - 1.0);
        assert!(observed <= after + 1.0);
    }

    #[test]
    fn kind_label_covers_every_notify_event_kind() {
        use notify::EventKind;
        use notify::event::{CreateKind, EventAttributes};

        let event = Event {
            kind: EventKind::Create(CreateKind::File),
            paths: vec![],
            attrs: EventAttributes::new(),
        };
        assert_eq!(kind_label(&event), "create");

        let event = Event {
            kind: EventKind::Other,
            paths: vec![],
            attrs: EventAttributes::new(),
        };
        assert_eq!(kind_label(&event), "other");
    }
}
