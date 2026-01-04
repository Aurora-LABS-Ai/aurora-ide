import { type ManifestConfig, generateManifest } from "material-icon-theme";

/**
 * Resolves the icon name for a given file or folder.
 * This mimics the VS Code resolution logic (Filename > Extension > Language > Default).
 */
export const getIconName = (name: string, isFolder: boolean, isOpen: boolean = false): string => {
  const lowerName = name.toLowerCase();

  // --- FOLDER LOGIC ---
  if (isFolder) {
    // 1. Check specific folder names (e.g., "src", "components")
    const specificFolder = isOpen
      ? manifest.folderNamesExpanded?.[lowerName]
      : manifest.folderNames?.[lowerName];

    if (specificFolder) return specificFolder;

    // 2. Return default folder theme
    return isOpen
      ? manifest.folderExpanded || 'folder-open' // fallback
      : manifest.folder || 'folder'; // fallback
  }

  // --- FILE LOGIC ---

  // 1. Check exact file names (e.g., "package.json", ".gitignore")
  const exactFileMatch = manifest.fileNames?.[name]; // Note: fileNames key is case-sensitive in manifest usually, but let's check exact
  if (exactFileMatch) return exactFileMatch;

  // Check lower case exact match just in case
  const lowerFileMatch = manifest.fileNames?.[lowerName];
  if (lowerFileMatch) return lowerFileMatch;

  // 2. Check extensions (e.g., "ts", "component.ts")
  const parts = name.split('.');

  // Check compound extensions first (e.g., "test.ts", "config.js")
  if (parts.length > 2) {
    const compoundExt = parts.slice(-2).join('.').toLowerCase();
    const compoundMatch = manifest.fileExtensions?.[compoundExt];
    if (compoundMatch) return compoundMatch;
  }

  // Check single extension
  const ext = parts.pop()?.toLowerCase();
  if (ext) {
    const extMatch = manifest.fileExtensions?.[ext];
    if (extMatch) return extMatch;

    // 3. Check languageIds for common extensions not in fileExtensions
    // The manifest uses languageIds for some icons like typescript, javascript, etc.
    const extToLanguage: Record<string, string> = {
      'ts': 'typescript',
      'js': 'javascript',
      'py': 'python',
      'rs': 'rust',
      'go': 'go',
      'rb': 'ruby',
      'java': 'java',
      'c': 'c',
      'cpp': 'cpp',
      'h': 'c',
      'hpp': 'cpp',
      'cs': 'csharp',
      'php': 'php',
      'swift': 'swift',
      'kt': 'kotlin',
      'scala': 'scala',
      'r': 'r',
      'lua': 'lua',
      'pl': 'perl',
      'sh': 'shell',
      'bash': 'shell',
      'zsh': 'shell',
      'ps1': 'powershell',
      'sql': 'database',
      'graphql': 'graphql',
      'gql': 'graphql',
    };

    const langId = extToLanguage[ext];
    if (langId) {
      // Use the languageId icon name directly
      const langMatch = manifest.languageIds?.[langId];
      if (langMatch) return langMatch;
    }
  }

  // 4. Fallback to default file
  return 'file';
};

/**
 * Helper to get the actual SVG URL/Path based on your build system.
 * Assuming usage of Vite/Webpack which can import SVGs from node_modules.
 */
export const getIconUrl = (iconName: string): string => {
  // If you are using Vite, you might need to copy icons to public or use a specific loader.
  // This is a direct path assumption that works in many modern setups.
  // Alternatively, you can use a CDN like jsdelivr for instant gratification without build config:
  return `https://cdn.jsdelivr.net/npm/material-icon-theme@latest/icons/${iconName}.svg`;
};

// 1. Generate the manifest once with your preferred configuration
const config: ManifestConfig = {
  activeIconPack: 'react', // 'react', 'angular', 'vue', 'nest', etc.
  hidesExplorerArrows: true,
  folders: {
    theme: 'specific', // 'specific' enables folder icons like 'src', 'components', etc.
  },
};
const manifest = generateManifest(config);
