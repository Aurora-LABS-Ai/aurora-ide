import { cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const sourceDir = resolve(
  repoRoot,
  "node_modules",
  "material-icon-theme",
  "icons",
);
const targetDir = resolve(repoRoot, "public", "material-icons");

if (!existsSync(sourceDir)) {
  throw new Error(`Material icon source directory not found: ${sourceDir}`);
}

mkdirSync(targetDir, { recursive: true });
cpSync(sourceDir, targetDir, {
  recursive: true,
  force: true,
});

console.log(
  `[sync-material-icons] Synced material icons to ${targetDir}`,
);
