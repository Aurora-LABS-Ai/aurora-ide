#!/usr/bin/env bash
# Build the headless `aurora` engine for x86_64 Linux, natively, on a machine
# set up by setup-builder.sh. Expects the uploaded source in ~/aurora-src
# (same upload as build-arm.sh). Runs on the glibc of the build machine and
# newer: built on Ubuntu 24.04, it needs Ubuntu 24.04 or later (libssl3).
# Leaves the stripped program at ~/aurora-src/aurora-x64.
set -euo pipefail
export PATH="$HOME/.cargo/bin:$PATH"

cd "$HOME/aurora-src/src-tauri"
cargo build --profile release-fast --no-default-features --bin aurora

strip -o "$HOME/aurora-src/aurora-x64" target/release-fast/aurora
file "$HOME/aurora-src/aurora-x64"
ls -l "$HOME/aurora-src/aurora-x64"
