fn main() {
    materialize_onnxruntime_dlls();
    tauri_build::build()
}

/// Copies vendored ONNX Runtime / DirectML DLLs from `src-tauri/runtime/onnxruntime/`
/// into the Cargo target directory so that `cargo run` and Tauri dev/release builds
/// can locate them next to `aurora.exe` at runtime.
///
/// The vendor directory is the single source of truth and lives outside Cargo's
/// `build/` target output, so wiping `build/` does not destroy the runtime payload.
/// `tauri.conf.json` references the same vendor directory under `bundle.resources`.
#[cfg(windows)]
fn materialize_onnxruntime_dlls() {
    use std::path::{Path, PathBuf};

    let Ok(manifest_dir) = std::env::var("CARGO_MANIFEST_DIR") else {
        return;
    };
    let vendor_dir = PathBuf::from(&manifest_dir)
        .join("runtime")
        .join("onnxruntime");

    println!("cargo:rerun-if-changed={}", vendor_dir.display());

    if !vendor_dir.is_dir() {
        println!(
            "cargo:warning=Vendor directory missing: {}. ONNX Runtime DLLs will not be staged for dev runs. \
             Populate it with onnxruntime*.dll and DirectML*.dll before running the app.",
            vendor_dir.display()
        );
        return;
    }

    let Ok(out_dir) = std::env::var("OUT_DIR") else {
        return;
    };
    let target_dir: Option<PathBuf> = PathBuf::from(out_dir)
        .ancestors()
        .nth(3)
        .map(Path::to_path_buf);
    let Some(target_dir) = target_dir else {
        return;
    };

    let dll_names = [
        "onnxruntime.dll",
        "onnxruntime_providers_shared.dll",
        "onnxruntime_providers_cuda.dll",
        "onnxruntime_providers_tensorrt.dll",
        "onnxruntime_providers_dml.dll",
        "DirectML.dll",
    ];

    // Stage into every directory cargo may launch a binary from:
    //   target_dir/                  → `cargo run` (release/debug aurora.exe)
    //   target_dir/deps/             → `cargo test` (per-test exe lives here)
    //   target_dir/examples/         → `cargo run --example`
    // Windows only searches the exe's own directory for DLLs, so each one
    // needs its own copy.
    let stage_dirs = [
        target_dir.clone(),
        target_dir.join("deps"),
        target_dir.join("examples"),
    ];

    for stage in &stage_dirs {
        if !stage.is_dir() {
            // `examples/` may not exist for crates without examples — skip.
            if stage.file_name().and_then(|n| n.to_str()) == Some("examples") {
                continue;
            }
            // For `deps/`, cargo creates it before invoking us, so it should
            // exist; if not, fall through to copy and let std::fs surface the
            // real error.
            if let Err(err) = std::fs::create_dir_all(stage) {
                println!(
                    "cargo:warning=Failed to create stage dir {}: {}",
                    stage.display(),
                    err
                );
                continue;
            }
        }

        for name in dll_names {
            let source = vendor_dir.join(name);
            if !source.is_file() {
                continue;
            }
            let dest = stage.join(name);

            if files_are_identical(&source, &dest) {
                continue;
            }

            if let Err(err) = std::fs::copy(&source, &dest) {
                println!(
                    "cargo:warning=Failed to stage {} into {}: {}",
                    source.display(),
                    dest.display(),
                    err
                );
            }
        }
    }
}

#[cfg(windows)]
fn files_are_identical(a: &std::path::Path, b: &std::path::Path) -> bool {
    let Ok(meta_a) = std::fs::metadata(a) else {
        return false;
    };
    let Ok(meta_b) = std::fs::metadata(b) else {
        return false;
    };
    if meta_a.len() != meta_b.len() {
        return false;
    }
    match (meta_a.modified(), meta_b.modified()) {
        (Ok(ma), Ok(mb)) => mb >= ma,
        _ => false,
    }
}

#[cfg(not(windows))]
fn materialize_onnxruntime_dlls() {}
