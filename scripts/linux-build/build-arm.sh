#!/usr/bin/env bash
# Cross-build the headless `aurora` engine for aarch64 Linux on a machine set
# up by setup-builder.sh. Expects the uploaded source in ~/aurora-src
# (src-tauri/, crates/, and the four src/ files include_str! reads).
# Leaves the stripped program at ~/aurora-src/aurora-arm64.
set -euo pipefail
export PATH="$HOME/.cargo/bin:$PATH"
export CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_LINKER=aarch64-linux-gnu-gcc
export CC_aarch64_unknown_linux_gnu=aarch64-linux-gnu-gcc
export CXX_aarch64_unknown_linux_gnu=aarch64-linux-gnu-g++
export AR_aarch64_unknown_linux_gnu=aarch64-linux-gnu-ar
export PKG_CONFIG_ALLOW_CROSS=1
export PKG_CONFIG_PATH=/usr/lib/aarch64-linux-gnu/pkgconfig
export PKG_CONFIG_LIBDIR=/usr/lib/aarch64-linux-gnu/pkgconfig

cd "$HOME/aurora-src/src-tauri"
cargo build --profile release-fast --no-default-features \
  --target aarch64-unknown-linux-gnu --bin aurora

out=target/aarch64-unknown-linux-gnu/release-fast/aurora
aarch64-linux-gnu-strip -o "$HOME/aurora-src/aurora-arm64" "$out"
file "$HOME/aurora-src/aurora-arm64"
ls -l "$HOME/aurora-src/aurora-arm64"
