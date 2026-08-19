# Library Lending

`library-lending` is a small, dependency-free Rust project used as an Urdira
end-to-end indexing fixture. It models lending one book to one library member
through a repository trait and an in-memory implementation.

Run the fixture with:

```bash
cargo test
cargo run
```

The executable lends *The Left Hand of Darkness* to Ada and prints the
resulting loan. The integration tests cover a successful loan, a missing book,
and an unavailable book.
