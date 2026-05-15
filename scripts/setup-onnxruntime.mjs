#!/usr/bin/env node
/**
 * Fetch ONNX Runtime CPU DLLs into `src-tauri/runtime/onnxruntime/`
 * so the Tauri bundler can pick them up as `bundle.resources`.
 *
 * Local devs and the GitHub Actions release workflow both call this
 * before building. The runtime DLLs are NOT checked in (each
 * machine populates them lazily — see `.gitignore`); this script
 * makes that population reproducible.
 *
 * Default behaviour: CPU-only, no DirectML / CUDA / TensorRT. Pulls
 * the latest pinned ONNX Runtime release for win-x64 from Microsoft's
 * official GitHub releases. Override the version with:
 *
 *   node scripts/setup-onnxruntime.mjs --version 1.20.1
 *
 * Skips the download if the target dir already has `onnxruntime.dll`,
 * so re-runs are cheap on dev machines.
 */
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir, platform } from "node:os";

const DEFAULT_VERSION = "1.20.1";

const args = process.argv.slice(2);
const versionFlagIdx = args.indexOf("--version");
const version =
  versionFlagIdx !== -1 && args[versionFlagIdx + 1]
    ? args[versionFlagIdx + 1]
    : DEFAULT_VERSION;
const force = args.includes("--force");

const rootDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const targetDir = join(rootDir, "src-tauri", "runtime", "onnxruntime");

if (platform() !== "win32") {
  // Other platforms link ONNX Runtime differently; the win-x64 bundle
  // is only relevant for the Windows Tauri build. Bail silently so a
  // macOS / Linux developer can still run `pnpm install` without
  // hitting this script.
  console.log(
    `[setup-onnxruntime] platform=${platform()} — skipping (Windows-only)`,
  );
  process.exit(0);
}

mkdirSync(targetDir, { recursive: true });

const targetHasDll = existsSync(join(targetDir, "onnxruntime.dll"));
if (targetHasDll && !force) {
  console.log(
    `[setup-onnxruntime] onnxruntime.dll already present in ${targetDir} — skipping download. Pass --force to refresh.`,
  );
  process.exit(0);
}

const archiveName = `onnxruntime-win-x64-${version}`;
const url = `https://github.com/microsoft/onnxruntime/releases/download/v${version}/${archiveName}.zip`;
const stagingDir = join(tmpdir(), `aurora-onnxruntime-${process.pid}`);
const zipPath = join(stagingDir, `${archiveName}.zip`);

mkdirSync(stagingDir, { recursive: true });

console.log(`[setup-onnxruntime] Fetching ${url}`);

// Use PowerShell rather than fetch() so we don't pull a Node 18+
// dependency. The release workflow runs on windows-latest where
// pwsh is always available.
const downloadResult = spawnSync(
  "powershell",
  [
    "-NoProfile",
    "-Command",
    `Invoke-WebRequest -UseBasicParsing -Uri '${url}' -OutFile '${zipPath}'`,
  ],
  { stdio: "inherit" },
);
if (downloadResult.status !== 0) {
  console.error(
    `[setup-onnxruntime] PowerShell download failed (exit ${downloadResult.status}).`,
  );
  process.exit(downloadResult.status ?? 1);
}

console.log(`[setup-onnxruntime] Extracting to ${stagingDir}`);
const extractResult = spawnSync(
  "powershell",
  [
    "-NoProfile",
    "-Command",
    `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${stagingDir}' -Force`,
  ],
  { stdio: "inherit" },
);
if (extractResult.status !== 0) {
  console.error(
    `[setup-onnxruntime] PowerShell Expand-Archive failed (exit ${extractResult.status}).`,
  );
  process.exit(extractResult.status ?? 1);
}

const libDir = join(stagingDir, archiveName, "lib");
if (!existsSync(libDir)) {
  console.error(
    `[setup-onnxruntime] Expected ${libDir} after extraction, not found.`,
  );
  process.exit(1);
}

// Copy only the DLLs — skip the .lib / .pdb so we don't bloat the
// bundle. The CPU runtime + the shared providers DLL is enough for
// semantic search; DirectML / CUDA / TensorRT providers are
// developer-opt-in (and live next to these DLLs only on machines
// that wanted them).
const dlls = readdirSync(libDir).filter((entry) => entry.endsWith(".dll"));
if (dlls.length === 0) {
  console.error(`[setup-onnxruntime] No DLLs found in ${libDir}.`);
  process.exit(1);
}

let copied = 0;
for (const dll of dlls) {
  const src = join(libDir, dll);
  const dst = join(targetDir, dll);
  renameSync(src, dst);
  copied += 1;
  console.log(`[setup-onnxruntime]  + ${dll}`);
}

// Best-effort cleanup of the staging dir. Don't fail the script on
// a leftover handle (Windows Defender sometimes holds zips open).
try {
  rmSync(stagingDir, { recursive: true, force: true });
} catch (err) {
  console.warn(`[setup-onnxruntime] Could not clean ${stagingDir}: ${err}`);
}

console.log(
  `[setup-onnxruntime] ${copied} DLL(s) installed into ${targetDir} (v${version}).`,
);
