fn main() {
    napi_build::setup();
    let target = std::env::var("TARGET").expect("Cargo must define TARGET");
    println!("cargo:rustc-env=URDIRA_NATIVE_TARGET={target}");
}
