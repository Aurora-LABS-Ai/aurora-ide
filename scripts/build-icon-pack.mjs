import { spawnSync } from "node:child_process";

const forwardedArgs = process.argv.slice(2);
const normalizedArgs =
  forwardedArgs[0] === "--" ? forwardedArgs.slice(1) : forwardedArgs;

const result = spawnSync(
  "cargo",
  [
    "run",
    "--manifest-path",
    "src-tauri/Cargo.toml",
    "--bin",
    "aurora",
    "--",
    "icon-pack",
    "build",
    ...normalizedArgs,
  ],
  {
    stdio: "inherit",
  },
);

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? 1);
