import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const materialSourceDir = resolve(
  repoRoot,
  "node_modules",
  "material-icon-theme",
  "icons",
);
const materialTargetDir = resolve(repoRoot, "public", "material-icons");
const vscodeIconifySource = resolve(
  repoRoot,
  "node_modules",
  "@iconify-json",
  "vscode-icons",
  "icons.json",
);
const vscodeTargetDir = resolve(repoRoot, "public", "vscode-icons");

if (!existsSync(materialSourceDir)) {
  throw new Error(`Material icon source directory not found: ${materialSourceDir}`);
}

if (!existsSync(vscodeIconifySource)) {
  throw new Error(`VS Code icon source file not found: ${vscodeIconifySource}`);
}

mkdirSync(materialTargetDir, { recursive: true });
cpSync(materialSourceDir, materialTargetDir, {
  recursive: true,
  force: true,
});

const iconifyData = JSON.parse(readFileSync(vscodeIconifySource, "utf8"));
const defaultWidth = iconifyData.width ?? 32;
const defaultHeight = iconifyData.height ?? 32;

const svgForIcon = (icon) => {
  const width = icon.width ?? defaultWidth;
  const height = icon.height ?? defaultHeight;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" fill="none">${icon.body}</svg>\n`;
};

const resolveIconDefinition = (iconName) => {
  if (iconifyData.icons[iconName]) {
    return iconifyData.icons[iconName];
  }

  const alias = iconifyData.aliases?.[iconName];
  if (!alias) return null;

  const parent = resolveIconDefinition(alias.parent);
  if (!parent) return null;

  return {
    ...parent,
    width: alias.width ?? parent.width,
    height: alias.height ?? parent.height,
  };
};

rmSync(vscodeTargetDir, { recursive: true, force: true });
mkdirSync(vscodeTargetDir, { recursive: true });

const allIconNames = [
  ...Object.keys(iconifyData.icons),
  ...Object.keys(iconifyData.aliases ?? {}),
];

for (const iconName of allIconNames) {
  const icon = resolveIconDefinition(iconName);
  if (!icon) {
    throw new Error(`Unable to resolve VS Code icon definition for "${iconName}"`);
  }

  writeFileSync(resolve(vscodeTargetDir, `${iconName}.svg`), svgForIcon(icon), "utf8");
}

console.log(`[sync-material-icons] Synced material icons to ${materialTargetDir}`);
console.log(`[sync-material-icons] Generated VS Code icons to ${vscodeTargetDir}`);
