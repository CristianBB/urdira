# Decision 25 fuzzing

This package is intentionally excluded from the production Cargo workspace.
It pins its own dependencies and lockfile while compiling against the same
Rust 1.98.0 production crates.

The targets are:

- `worker_framing`: arbitrary and valid `urdira.ipc.v2` Protobuf frame streams;
- `logical_digest`: bounded logical records and digest verification batches;
- `fact_delta_stream_batch`: arbitrary JSON plus bounded structured batches
  checked against a fuzz-only mirror of the closed Schema IR batch invariants.

Targets are hermetic. They do not read source workspaces, access the network,
spawn commands, or write files. Corpus and artifact I/O is owned by
`cargo-fuzz`, outside the target functions.

Compile the targets with the supported stable compiler:

```bash
cargo +1.98.0 check --manifest-path fuzz/Cargo.toml --locked --bins
```

Run a bounded smoke campaign with the pinned cargo-fuzz tool:

```bash
cargo install cargo-fuzz --version 0.13.2 --locked
cargo +nightly-2026-08-26 fuzz run worker_framing -- -runs=256 -max_len=65536 -timeout=10
cargo +nightly-2026-08-26 fuzz run logical_digest -- -runs=256 -max_len=65536 -timeout=10
cargo +nightly-2026-08-26 fuzz run fact_delta_stream_batch -- -runs=256 -max_len=65536 -timeout=10
```

Any minimized reproducer belongs under the corresponding `corpus/` directory.
Crash artifacts remain ignored until reviewed and converted into a regression
test or a safe corpus entry.
