# Aurora IDE — Platform-aware setup script (Windows PowerShell)
# Detects GPU and builds with correct feature flags.

$ErrorActionPreference = "Stop"

function Write-Info  { param($m) Write-Host "[info]  $m" -ForegroundColor Cyan }
function Write-Ok    { param($m) Write-Host "[ok]    $m" -ForegroundColor Green }
function Write-Warn  { param($m) Write-Host "[warn]  $m" -ForegroundColor Yellow }
function Write-Fail  { param($m) Write-Host "[error] $m" -ForegroundColor Red; exit 1 }

Write-Host ""
Write-Host "Aurora IDE - Setup" -ForegroundColor Cyan
Write-Host "================================"
Write-Host ""

# --- Check prerequisites ---
Write-Info "Checking prerequisites..."

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Fail "Node.js not found. Install from https://nodejs.org (v18+)"
}
if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
    Write-Fail "Rust/Cargo not found. Install from https://rustup.rs"
}
if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
    Write-Fail "pnpm not found. Install with: npm install -g pnpm"
}

$nodeVer = [int]((node -v) -replace 'v(\d+)\..*', '$1')
if ($nodeVer -lt 18) {
    Write-Fail "Node.js v18+ required (found v$nodeVer). Update at https://nodejs.org"
}

Write-Ok "Node.js $(node -v)"
Write-Ok "Rust $((rustc --version) -replace 'rustc ', '')"
Write-Ok "pnpm $(pnpm --version)"

# --- Detect GPU ---
Write-Info "Detecting GPU..."

$features = ""

try {
    $nvidiaSmi = Get-Command nvidia-smi -ErrorAction SilentlyContinue
    if ($nvidiaSmi -and (nvidia-smi 2>$null)) {
        $features = "--features cuda"
        Write-Ok "NVIDIA GPU detected - using CUDA acceleration"
    }
}
catch { }

if (-not $features) {
    try {
        $dxDiag = Get-CimInstance -ClassName Win32_VideoController -ErrorAction SilentlyContinue
        if ($dxDiag) {
            $gpuName = ($dxDiag | Select-Object -First 1).Name
            if ($gpuName -match "AMD|Radeon|Intel|Arc") {
                $features = "--features directml"
                Write-Ok "GPU detected ($gpuName) - using DirectML acceleration"
            }
            else {
                $features = "--features directml"
                Write-Ok "GPU detected ($gpuName) - using DirectML acceleration"
            }
        }
    }
    catch {
        Write-Info "No GPU detected - using CPU-only mode"
    }
}

# --- Install dependencies ---
Write-Host ""
Write-Info "Installing frontend dependencies..."
pnpm install

# --- Build ---
Write-Host ""
Push-Location src-tauri

if ($features) {
    Write-Info "Building with: cargo build --no-default-features $features"
    $buildArgs = @("build", "--no-default-features") + ($features -split " ")
    & cargo @buildArgs
}
else {
    Write-Info "Building with default (CPU-only) features..."
    cargo build
}

Pop-Location

Write-Host ""
Write-Host "================================"
Write-Ok "Setup complete!"
Write-Host ""
Write-Info "To start Aurora in development mode:"
Write-Host "  pnpm tauri:dev"
Write-Host ""
Write-Info "To build for production:"
Write-Host "  pnpm tauri:build"
Write-Host ""
