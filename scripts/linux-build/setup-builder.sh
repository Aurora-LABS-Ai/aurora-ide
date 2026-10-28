#!/usr/bin/env bash
# Prepare a fresh x86_64 Ubuntu 24.04 machine to cross-build the headless
# `aurora` engine for aarch64 Linux (the Oracle ARM box). Run as root.
# Recipe from .knowledge/knowledge.md, 2026-10-28 (session 7).
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

# First boot runs its own apt jobs; wait for them instead of failing on the lock.
cloud-init status --wait >/dev/null 2>&1 || true
while fuser /var/lib/apt/lists/lock /var/lib/dpkg/lock-frontend >/dev/null 2>&1; do sleep 3; done

# arm64 packages come from ports.ubuntu.com; the main sources stay amd64-only.
dpkg --add-architecture arm64
sed -i '/^Types:/a Architectures: amd64' /etc/apt/sources.list.d/ubuntu.sources
cat > /etc/apt/sources.list.d/arm64-ports.sources <<'EOF'
Types: deb
URIs: http://ports.ubuntu.com/ubuntu-ports
Suites: noble noble-updates noble-security
Components: main restricted universe multiverse
Architectures: arm64
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg
EOF

apt-get update -qq
apt-get install -y -qq build-essential pkg-config curl ca-certificates \
  libssl-dev gcc-aarch64-linux-gnu g++-aarch64-linux-gnu libssl-dev:arm64 >/dev/null

if ! command -v rustup >/dev/null 2>&1 && [ ! -x "$HOME/.cargo/bin/rustup" ]; then
  curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain 1.92.0
fi
"$HOME/.cargo/bin/rustup" target add aarch64-unknown-linux-gnu

echo "builder ready: $("$HOME/.cargo/bin/rustc" --version)"
