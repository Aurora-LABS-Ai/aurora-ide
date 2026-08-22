#[cfg(feature = "cpp")]
#[cfg(not(target_os = "macos"))]
fn main() {
    let mut build = cc::Build::new();
    build.cpp(true).static_crt(false);
    if cfg!(target_env = "msvc") {
        build.flag("/std:c++14");
    } else {
        build.flag("-std=c++11");
    }
    build.file("src/esaxx.cpp").include("src").compile("esaxx");
}

#[cfg(feature = "cpp")]
#[cfg(target_os = "macos")]
fn main() {
    cc::Build::new()
        .cpp(true)
        .flag("-std=c++11")
        .flag("-stdlib=libc++")
        .static_crt(false)
        .file("src/esaxx.cpp")
        .include("src")
        .compile("esaxx");
}

#[cfg(not(feature = "cpp"))]
fn main() {}
