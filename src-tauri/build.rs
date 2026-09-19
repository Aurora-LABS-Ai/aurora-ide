fn main() {
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

    let (Ok(manifest_dir), Ok(target_triple)) =
        (std::env::var("CARGO_MANIFEST_DIR"), std::env::var("TARGET"))
    else {
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
    let Some(target_dir) = PathBuf::from(out_dir)
        .ancestors()
        .nth(3)
        .map(Path::to_path_buf)
    else {
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


/// Cheap "already staged?" check — size plus a not-older mtime, so a rebuild
/// does not re-copy the sidecar binaries every time.
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
