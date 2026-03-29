#!/usr/bin/env bash
set -euo pipefail

# Aurora IDE — Platform-aware setup script
# Detects OS/GPU and builds with correct feature flags.

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

info()  { echo -e "${CYAN}[info]${NC}  $1"; }
ok()    { echo -e "${GREEN}[ok]${NC}    $1"; }
warn()  { echo -e "${YELLOW}[warn]${NC}  $1"; }
fail()  { echo -e "${RED}[error]${NC} $1"; exit 1; }

echo ""
echo -e "${CYAN}Aurora IDE — Setup${NC}"
echo "================================"
echo ""

# --- Check prerequisites ---
info "Checking prerequisites..."

command -v node  >/dev/null 2>&1 || fail "Node.js not found. Install from https://nodejs.org (v18+)"
command -v cargo >/dev/null 2>&1 || fail "Rust/Cargo not found. Install from https://rustup.rs"
command -v pnpm  >/dev/null 2>&1 || fail "pnpm not found. Install with: npm install -g pnpm"

NODE_VER=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VER" -lt 18 ]; then
  fail "Node.js v18+ required (found v$NODE_VER). Update at https://nodejs.org"
fi

ok "Node.js $(node -v)"
ok "Rust $(rustc --version | awk '{print $2}')"
ok "pnpm $(pnpm --version)"

# --- Detect OS and GPU ---
info "Detecting platform..."

OS="$(uname -s)"
FEATURES=""

case "$OS" in
  Darwin)
    ok "macOS detected"
    if system_profiler SPDisplaysDataType 2>/dev/null | grep -qi "apple\|m1\|m2\|m3\|m4"; then
      FEATURES="--features coreml"
      ok "Apple Silicon GPU detected — using CoreML acceleration"
    else
      info "No Apple Silicon detected — using CPU-only mode"
    fi
    ;;
  Linux)
    ok "Linux detected"
    if command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi >/dev/null 2>&1; then
      FEATURES="--features cuda"
      ok "NVIDIA GPU detected — using CUDA acceleration"
    else
      info "No NVIDIA GPU detected — using CPU-only mode"
    fi
    ;;
  MINGW*|MSYS*|CYGWIN*)
    ok "Windows detected (via Git Bash / MSYS)"
    if command -v nvidia-smi.exe >/dev/null 2>&1 && nvidia-smi.exe >/dev/null 2>&1; then
      FEATURES="--features cuda"
      ok "NVIDIA GPU detected — using CUDA acceleration"
    else
      FEATURES="--features directml"
      ok "Using DirectML for GPU acceleration"
    fi
    ;;
  *)
    warn "Unknown OS ($OS) — using CPU-only mode"
    ;;
esac

# --- Install dependencies ---
echo ""
info "Installing frontend dependencies..."
pnpm install

# --- Build ---
echo ""
if [ -n "$FEATURES" ]; then
  info "Building with: cargo build --no-default-features $FEATURES"
  echo ""
  cd src-tauri
  cargo build --no-default-features $FEATURES
  cd ..
else
  info "Building with default (CPU-only) features..."
  echo ""
  cd src-tauri
  cargo build
  cd ..
fi

echo ""
echo "================================"
ok "Setup complete!"
echo ""
info "To start Aurora in development mode:"
echo "  pnpm tauri:dev"
echo ""
info "To build for production:"
echo "  pnpm tauri:build"
echo ""
