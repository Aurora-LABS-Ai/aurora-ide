import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";

const usage = `Usage:
  pnpm crispasr:package -- --source <runtime-folder> [--output <zip-path>]

Example:
  pnpm crispasr:package -- --source "C:\\Users\\Alvan\\AppData\\Local\\Aurora\\crispasr-runtime\\windows-x64"
`;

const readArg = (name) => {
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  return process.argv[index + 1] ?? null;
};

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(usage);
  process.exit(0);
}

const sourceArg = readArg("--source");
if (!sourceArg) {
  console.error(usage);
  process.exit(1);
}

const source = resolve(sourceArg);
const output = resolve(
  readArg("--output") ?? "dist/aurora-crispasr-runtime-windows-x64.zip",
);
const executable = resolve(source, "crispasr.exe");

if (!existsSync(source)) {
  console.error(`[crispasr:package] Source folder does not exist: ${source}`);
  process.exit(1);
}

if (!existsSync(executable)) {
  console.error(`[crispasr:package] Source folder must contain crispasr.exe: ${source}`);
  process.exit(1);
}

mkdirSync(dirname(output), { recursive: true });
rmSync(output, { force: true });

const sourcePattern = resolve(source, "*");
const command = [
  "$ErrorActionPreference = 'Stop';",
  `Compress-Archive -Path ${JSON.stringify(sourcePattern)} -DestinationPath ${JSON.stringify(output)} -Force`,
].join(" ");

const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", command], {
  stdio: "inherit",
});

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

console.log(`[crispasr:package] Wrote ${output}`);
