import { existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const usage = `Usage:
  pnpm tauri:dev:cuda
  pnpm tauri:build:cuda
  pnpm cuda:check

This wrapper loads the Visual Studio x64 C++ toolchain before invoking CUDA builds.
`;

const mode = process.argv[2];
const forwardedArgs = process.argv.slice(3);
const extraArgs = forwardedArgs[0] === "--" ? forwardedArgs.slice(1) : forwardedArgs;

if (!mode || mode === "--help" || mode === "-h") {
  console.log(usage);
  process.exit(mode ? 0 : 1);
}

const quoteCmd = (value) => {
  if (/^[A-Za-z0-9_./:=,-]+$/.test(value)) {
    return value;
  }
  return `"${value.replace(/"/g, '""')}"`;
};

const findVsInstall = () => {
  const vswhere = "C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe";
  if (existsSync(vswhere)) {
    const result = spawnSync(vswhere, [
      "-latest",
      "-products",
      "*",
      "-requires",
      "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
      "-property",
      "installationPath",
    ], {
      encoding: "utf8",
    });

    const installPath = result.stdout.trim();
    if (result.status === 0 && installPath) {
      return installPath;
    }
  }

  const candidates = [
    "C:\\Program Files\\Microsoft Visual Studio\\2022\\Community",
    "C:\\Program Files\\Microsoft Visual Studio\\2022\\Professional",
    "C:\\Program Files\\Microsoft Visual Studio\\2022\\Enterprise",
    "C:\\Program Files\\Microsoft Visual Studio\\2022\\BuildTools",
  ];

  return candidates.find((candidate) => existsSync(candidate)) ?? null;
};

const vsInstall = findVsInstall();
const vsDevCmd = vsInstall ? join(vsInstall, "Common7", "Tools", "VsDevCmd.bat") : null;

if (!vsDevCmd || !existsSync(vsDevCmd)) {
  console.error("[tauri:cuda] Visual Studio C++ build tools were not found.");
  console.error("Install the Visual Studio workload: Desktop development with C++.");
  process.exit(1);
}

const tauriCommand = mode === "check"
  ? "where cl && nvcc --version"
  : `pnpm exec tauri ${quoteCmd(mode)} --features cuda ${extraArgs.map(quoteCmd).join(" ")}`.trim();

const batchPath = join(tmpdir(), `aurora-tauri-cuda-${process.pid}.cmd`);
const batch = [
  "@echo off",
  `call ${quoteCmd(vsDevCmd)} -arch=x64 -host_arch=x64`,
  "if errorlevel 1 exit /b %errorlevel%",
  tauriCommand,
  "exit /b %errorlevel%",
  "",
].join("\r\n");

writeFileSync(batchPath, batch, "utf8");

const result = spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/c", batchPath], {
  stdio: "inherit",
  env: process.env,
});

rmSync(batchPath, { force: true });

process.exit(result.status ?? 1);
