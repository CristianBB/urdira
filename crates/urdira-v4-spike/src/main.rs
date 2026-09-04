//! urdira-v4-spike: P0-S1 measured spike deciding the v4 structural store.
//! See docs/evidence/2026-09-02-v4-p0-s1-store-floor.md for the protocol
//! and results. Throwaway crate -- not part of the shipped product.

mod bin_io;
mod ddl;
mod delta;
mod deps;
mod dict;
mod layout;
mod load;
mod order;
mod query;
mod replay_a;
mod replay_b;
mod replay_c;
mod row;
mod util;

pub type AnyResult<T> = Result<T, Box<dyn std::error::Error + Send + Sync>>;

fn usage() -> ! {
    eprintln!(
        "usage:\n\
         \x20 urdira-v4-spike load <db-path> <relations-bin> <out-dir>\n\
         \x20 urdira-v4-spike replay-a <cache.bin> <deps.bin> <out.sqlite>\n\
         \x20 urdira-v4-spike replay-b <cache.bin> <out-dir>\n\
         \x20 urdira-v4-spike replay-c <cache.bin> <out-dir>\n\
         \x20 urdira-v4-spike query <a|b|c> <cache.bin> <store-path>\n\
         \x20 urdira-v4-spike delta <a|b|c> <cache.bin> <store-path>\n"
    );
    std::process::exit(2)
}

fn main() -> AnyResult<()> {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 2 {
        usage();
    }
    match args[1].as_str() {
        "load" => {
            if args.len() != 5 {
                usage();
            }
            load::run(&args[2], &args[3], &args[4])?;
        }
        "replay-a" => {
            if args.len() != 5 {
                usage();
            }
            let store = row::load_store(std::path::Path::new(&args[2]))?;
            let deps = deps::load_deps(std::path::Path::new(&args[3]))?;
            let timings = replay_a::run(&store, &deps, std::path::Path::new(&args[4]))?;
            timings.report("replay-a");
        }
        "replay-b" => {
            if args.len() != 4 {
                usage();
            }
            let store = row::load_store(std::path::Path::new(&args[2]))?;
            let timings = replay_b::run(&store, std::path::Path::new(&args[3]))?;
            timings.report("replay-b");
        }
        "replay-c" => {
            if args.len() != 4 {
                usage();
            }
            let store = row::load_store(std::path::Path::new(&args[2]))?;
            let timings = replay_c::run(&store, std::path::Path::new(&args[3]))?;
            timings.report("replay-c");
        }
        "query" => {
            if args.len() != 5 {
                usage();
            }
            query::run(
                &args[2],
                std::path::Path::new(&args[3]),
                std::path::Path::new(&args[4]),
            )?;
        }
        "delta" => {
            if args.len() != 5 {
                usage();
            }
            let store = row::load_store(std::path::Path::new(&args[3]))?;
            let target_path = std::path::Path::new(&args[4]);
            let result = match args[2].as_str() {
                "a" => delta::run_a(&store, target_path)?,
                "b" => delta::run_b(&store, target_path)?,
                "c" => delta::run_c(&store, target_path)?,
                other => {
                    eprintln!("unknown delta target: {other}");
                    std::process::exit(2)
                }
            };
            println!(
                "DELTA owner={} rows_closed={} elapsed_ms={:.2}",
                result.owner, result.rows_closed, result.elapsed_ms
            );
        }
        other => {
            eprintln!("unknown subcommand: {other}");
            usage();
        }
    }
    Ok(())
}
