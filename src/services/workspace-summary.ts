import { isTauri, readDirectory } from '../lib/tauri';

export interface WorkspaceSummary {
  name: string;
  fileCount: number;
  languages: string[];
  framework: string | null;
  hasGit: boolean;
  hasTsConfig: boolean;
  hasPackageJson: boolean;
}

const LANGUAGE_MAP: Record<string, string> = {
  ts: 'TypeScript',
  tsx: 'TypeScript',
  js: 'JavaScript',
  jsx: 'JavaScript',
  py: 'Python',
  rs: 'Rust',
  go: 'Go',
  java: 'Java',
  rb: 'Ruby',
  php: 'PHP',
  cs: 'C#',
  cpp: 'C++',
  c: 'C',
  swift: 'Swift',
  kt: 'Kotlin',
  vue: 'Vue',
  svelte: 'Svelte',
};

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', '.nuxt',
  'target', '__pycache__', '.venv', 'venv', '.idea', '.vscode',
  '.cursor', 'coverage', '.turbo', '.cache',
]);

export async function scanWorkspace(rootPath: string): Promise<WorkspaceSummary | null> {
  if (!isTauri()) return null;

  try {
    const name = rootPath.split(/[/\\]/).pop() || 'workspace';
    const langCounts = new Map<string, number>();
    let fileCount = 0;
    let hasGit = false;
    let hasTsConfig = false;
    let hasPackageJson = false;
    let framework: string | null = null;

    const entries = await readDirectory(rootPath);

    for (const entry of entries) {
      if (entry.name === '.git') { hasGit = true; continue; }
      if (entry.name === 'tsconfig.json') { hasTsConfig = true; }
      if (entry.name === 'package.json') { hasPackageJson = true; }
      if (entry.name === 'next.config.js' || entry.name === 'next.config.mjs' || entry.name === 'next.config.ts') { framework = 'Next.js'; }
      if (entry.name === 'nuxt.config.ts' || entry.name === 'nuxt.config.js') { framework = 'Nuxt'; }
      if (entry.name === 'vite.config.ts' || entry.name === 'vite.config.js') { framework = framework || 'Vite'; }
      if (entry.name === 'Cargo.toml') { framework = framework || 'Rust (Cargo)'; }
      if (entry.name === 'go.mod') { framework = framework || 'Go'; }
      if (entry.name === 'requirements.txt' || entry.name === 'pyproject.toml') { framework = framework || 'Python'; }
      if (entry.name === 'tauri.conf.json') { framework = 'Tauri'; }

      if (SKIP_DIRS.has(entry.name)) continue;

      if (entry.is_dir) {
        try {
          const subEntries = await readDirectory(entry.path);
          for (const sub of subEntries) {
            if (!sub.is_dir) {
              fileCount++;
              const ext = sub.name.split('.').pop()?.toLowerCase() || '';
              const lang = LANGUAGE_MAP[ext];
              if (lang) langCounts.set(lang, (langCounts.get(lang) || 0) + 1);
            }
          }
        } catch {
          // Skip inaccessible directories
        }
      } else {
        fileCount++;
        const ext = entry.name.split('.').pop()?.toLowerCase() || '';
        const lang = LANGUAGE_MAP[ext];
        if (lang) langCounts.set(lang, (langCounts.get(lang) || 0) + 1);
      }
    }

    const languages = [...langCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([lang]) => lang);

    return {
      name,
      fileCount,
      languages,
      framework,
      hasGit,
      hasTsConfig,
      hasPackageJson,
    };
  } catch {
    return null;
  }
}
