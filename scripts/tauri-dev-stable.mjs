import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const forwardedArgs = process.argv.slice(2);
const extraArgs = forwardedArgs[0] === "--" ? forwardedArgs.slice(1) : forwardedArgs;
const rootDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const targetDir = join(rootDir, "build");
const maxCapturedOutput = 512_000;

const recoverablePatterns = [
  /rust-lld:\s+error:\s+undefined symbol:/i,
  /undefined symbol:\s+anon\.[a-f0-9]+/i,
  /could not compile `aurora` \(lib\)/i,
];

const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

const appendOutput = (buffer, chunk) => {
  const next = buffer + chunk.toString();
  if (next.length <= maxCapturedOutput) {
    return next;
  }

  return next.slice(next.length - maxCapturedOutput);
};

const isRecoverableLinkerFailure = (output) =>
  recoverablePatterns.every((pattern) => pattern.test(output));

const removeMatchingEntries = (dir, predicate) => {
  if (!existsSync(dir)) {
    return 0;
  }

  let removed = 0;
  for (const entry of readdirSync(dir)) {
    if (!predicate(entry)) {
      continue;
    }

    const path = join(dir, entry);
    rmSync(path, { force: true, recursive: statSync(path).isDirectory() });
    removed += 1;
  }

  return removed;
};

const cleanAuroraDebugArtifacts = () => {
  const debugDir = join(targetDir, "debug");
  let removed = 0;

  removed += removeMatchingEntries(join(debugDir, "deps"), (entry) =>
    /^(aurora|aurora_lib)[-.]/.test(entry) || /^aurora_lib\./.test(entry)
  );
  removed += removeMatchingEntries(join(debugDir, ".fingerprint"), (entry) =>
    /^aurora-[a-f0-9]+$/.test(entry)
  );
  removed += removeMatchingEntries(join(debugDir, "incremental"), (entry) =>
    /^(aurora|aurora_lib)-/.test(entry)
  );
  removed += removeMatchingEntries(debugDir, (entry) =>
    /^aurora(_lib)?\.(dll|dll\.lib|d|exe|exp|ilk|lib|pdb)$/i.test(entry)
  );

  return removed;
};

const runTauriDev = (attempt) =>
  new Promise((resolveRun) => {
    const child = spawn(pnpmCommand, ["exec", "tauri", "dev", ...extraArgs], {
      cwd: rootDir,
      env: {
        ...process.env,
        CARGO_INCREMENTAL: "0",
        AURORA_TAURI_DEV_STABLE_ATTEMPT: String(attempt),
      },
      stdio: ["inherit", "pipe", "pipe"],
    });

    let output = "";

    const handleStdout = (chunk) => {
      output = appendOutput(output, chunk);
      process.stdout.write(chunk);
    };
    const handleStderr = (chunk) => {
      output = appendOutput(output, chunk);
      process.stderr.write(chunk);
    };

    child.stdout.on("data", handleStdout);
    child.stderr.on("data", handleStderr);

    const forwardSignal = (signal) => {
      child.kill(signal);
    };

    process.once("SIGINT", forwardSignal);
    process.once("SIGTERM", forwardSignal);

    child.on("close", (code, signal) => {
      process.removeListener("SIGINT", forwardSignal);
      process.removeListener("SIGTERM", forwardSignal);
      resolveRun({ code, signal, output });
    });
  });

for (let attempt = 1; attempt <= 2; attempt += 1) {
  const result = await runTauriDev(attempt);

  if (result.signal) {
    process.kill(process.pid, result.signal);
  }

  if (result.code === 0) {
    process.exit(0);
  }

  if (attempt === 1 && isRecoverableLinkerFailure(result.output)) {
    const removed = cleanAuroraDebugArtifacts();
    console.error(
      `[tauri:dev] Detected stale Aurora debug artifacts after a rust-lld link failure. ` +
        `Removed ${removed} crate-local build artifact(s) and retrying once.`
    );
    continue;
  }

  process.exit(result.code ?? 1);
}
