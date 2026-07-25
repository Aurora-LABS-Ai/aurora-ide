fn main() {
    materialize_onnxruntime_dlls();
    stage_sidecar_binaries();
    tauri_build::build()
}

/// Copy the vendored helper executables from `src-tauri/binaries/` into the
/// Cargo target directory, with the target-triple suffix stripped.
///
/// `tauri.conf.json` ships the same files as `bundle.externalBin`, which does
/// exactly this rename when packaging an installer. Dev runs never go through
/// the bundler, so without this step `cargo run` and `tauri dev` would resolve
/// ripgrep differently from a shipped build — the worst kind of difference,
/// because search would work on the developer's machine and fail in the
/// installer. Staging here makes `crate::sidecar` see one layout everywhere.
fn stage_sidecar_binaries() {
    use std::path::{Path, PathBuf};

    let (Ok(manifest_dir), Ok(target_triple)) = (
        std::env::var("CARGO_MANIFEST_DIR"),
        std::env::var("TARGET"),
    ) else {
        return;
    };
    let vendor_dir = PathBuf::from(&manifest_dir).join("binaries");
    println!("cargo:rerun-if-changed={}", vendor_dir.display());

    if !vendor_dir.is_dir() {
        println!(
            "cargo:warning=Sidecar directory missing: {}. `grep` will fall back to a PATH ripgrep. \
             Populate it with rg-{}{} before shipping.",
            vendor_dir.display(),
            target_triple,
            std::env::consts::EXE_SUFFIX
        );
        return;
    }

    let Ok(out_dir) = std::env::var("OUT_DIR") else {
        return;
    };
    let Some(target_dir) = PathBuf::from(out_dir).ancestors().nth(3).map(Path::to_path_buf) else {
        return;
    };

    // Same three launch directories the ONNX staging covers: `cargo run`,
    // `cargo test` (exe lives in deps/), and `cargo run --example`.
    let stage_dirs = [
        target_dir.clone(),
        target_dir.join("deps"),
        target_dir.join("examples"),
    ];

    for name in ["rg"] {
        let source = vendor_dir.join(format!(
            "{name}-{target_triple}{}",
            std::env::consts::EXE_SUFFIX
        ));
        if !source.is_file() {
            println!(
                "cargo:warning=Missing sidecar {}. `grep` will fall back to a PATH ripgrep.",
                source.display()
            );
            continue;
        }

        for stage in &stage_dirs {
            if !stage.is_dir() && std::fs::create_dir_all(stage).is_err() {
                continue;
            }
            let dest = stage.join(format!("{name}{}", std::env::consts::EXE_SUFFIX));
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

/// Cheap "already staged?" check — size plus a not-older mtime. Shared by the
/// ONNX and sidecar staging so neither re-copies megabytes on every build.
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
