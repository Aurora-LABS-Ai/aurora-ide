/**
 * Context Builder Service
 * Builds Cursor-style structured context for AI queries
 * Includes user info, workspace state, attached files, IDE context, project rules, and project layout
 * 
 * Implements the Cursor format structure:
 * - <user_info> - OS, Shell, Workspace Path
 * - <project_rules> - Rules from .aurora/*.md files
 * - <project_layout> - Static snapshot of file tree (persistent file map)
 * - <ide_context> - Open files, recent files
 * - <attached_files> - Files attached with @ syntax
 */
import type { AttachedFile } from "../components/chat/ChatInput";
import { getSystemInfo, readDirectory, readFileContent } from "../lib/tauri";
import { useEditorStore } from "../store/useEditorStore";
import { useWorkspaceStore } from "../store/useWorkspaceStore";
import type { FileNode } from "../types";

export interface BuiltContext {
  filesAsPathsOnly: string[];
  filesWithContent: FileContent[];
  formattedContext: string;
}

export interface ContextConfig {
  includeProjectLayout?: boolean; // Whether to include project layout (default: true for first message)
  openFiles?: Array<{ path: string; isActive: boolean; cursorLine?: number; totalLines?: number }>;
  osInfo?: string; // Full OS info like "win32 10.0.26200"
  projectLayout?: string; // Pre-built project tree string
  projectRules?: ProjectRule[]; // Rules from .aurora/*.md
  recentFiles?: string[];
  shellPath?: string; // Default shell path
  systemInfo?: {             // Cached system info from Tauri
    os: string;
    os_version: string;
    arch: string;
    shell: string | null;
  };
  workspacePath?: string;
}

export interface FileContent {
  content: string;
  lineCount: number;
name: string;
 path: string;
  truncated: boolean;
}

export interface ProjectRule {
  content: string;
  filename: string;
}

/**
 * Build attached files section with smart content limiting
 */
async function buildAttachedFiles(
  attachedFiles: AttachedFile[]
): Promise<{ section: string; filesWithContent: FileContent[]; filesAsPathsOnly: string[] }> {
  if (!attachedFiles || attachedFiles.length === 0) {
    return { section: '', filesWithContent: [], filesAsPathsOnly: [] };
  }

  const filesWithContent: FileContent[] = [];
  const filesAsPathsOnly: string[] = [];
  const fileSections: string[] = [];

  // Process files - first N get full content, rest get path only
  for (let i = 0; i < attachedFiles.length; i++) {
    const file = attachedFiles[i];

    if (i < MAX_FULL_CONTENT_FILES) {
      // Read and include full content
      try {
        const content = await readFileContent(file.path);
        const { formatted, lineCount, truncated } = formatFileWithLineNumbers(content, MAX_FILE_LINES);

        filesWithContent.push({
          path: file.path,
          name: file.name,
          content,
          lineCount,
          truncated,
        });

        fileSections.push(`<file path="${file.path}" lines="${lineCount}"${truncated ? ' truncated="true"' : ''}>
${formatted}
</file>`);
      } catch (error) {
        fileSections.push(`<file path="${file.path}" error="true">
Failed to read file: ${error}
</file>`);
      }
    } else {
      // Path only - instruct AI to use tool
      filesAsPathsOnly.push(file.path);
    }
  }

  // Add path-only files section if any
  if (filesAsPathsOnly.length > 0) {
    fileSections.push(`<additional_files note="Use file_read tool to access these files">
${filesAsPathsOnly.map(p => `- ${p}`).join('\n')}
</additional_files>`);
  }

  const section = `<attached_files count="${attachedFiles.length}" with_content="${filesWithContent.length}">
${fileSections.join('\n\n')}
</attached_files>`;

  return { section, filesWithContent, filesAsPathsOnly };
}

/**
 * Build open/recent files section
 */
function buildFileContext(config: ContextConfig): string {
  const sections: string[] = [];

  if (config.openFiles && config.openFiles.length > 0) {
    const openFilesStr = config.openFiles
      .map(f => {
        let info = f.path;
        if (f.isActive) {
          info += f.cursorLine ? ` (active, cursor at line ${f.cursorLine})` : ' (active)';
        }
        return `- ${info}`;
      })
      .join('\n');
    sections.push(`Open files in editor:\n${openFilesStr}`);
  }

  if (config.recentFiles && config.recentFiles.length > 0) {
    const recentStr = config.recentFiles
      .slice(0, 5) // Limit to 5 recent files
      .map(f => `- ${f}`)
      .join('\n');
    sections.push(`Recently viewed:\n${recentStr}`);
  }

  if (sections.length === 0) return '';

  return `<ide_context>
${sections.join('\n\n')}
</ide_context>`;
}

/**
 * Build project layout section (Cursor-style persistent file map)
 * This gives the agent a mental map of the project structure
 */
function buildProjectLayout(config: ContextConfig): string {
  if (!config.projectLayout) return '';

  return `<project_layout>
Below is a snapshot of this project's file structure. This snapshot is taken at conversation start and does NOT update during the conversation. Use workspace_tree tool if you need the latest structure.

${config.projectLayout}
</project_layout>`;
}

/**
 * Build project rules section
 */
function buildProjectRules(rules: ProjectRule[]): string {
  if (!rules || rules.length === 0) return '';

  const rulesContent = rules
    .map(rule => `<rule file="${rule.filename}">
${rule.content}
</rule>`)
    .join('\n\n');

  return `<project_rules description="Project-specific rules from .aurora/*.md files that must be followed">
${rulesContent}
</project_rules>`;
}

/**
 * Build user info section (Cursor-style)
 * Includes OS, date, shell, and workspace info
 */
function buildUserInfo(config: ContextConfig): string {
  const parts: string[] = [];

  if (config.osInfo) {
    parts.push(`OS Version: ${config.osInfo}`);
  }
  
  // Add current date (Cursor includes this)
  const now = new Date();
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const dateStr = `${days[now.getDay()]} ${months[now.getMonth()]} ${now.getDate()}, ${now.getFullYear()}`;
  parts.push(`Current Date: ${dateStr}`);
  
  if (config.shellPath) {
    parts.push(`Shell: ${config.shellPath}`);
  }
  if (config.workspacePath) {
    parts.push(`Workspace Path: ${config.workspacePath}`);
  }

  if (parts.length === 0) return '';

  return `<user_info>
${parts.join('\n')}
</user_info>`;
}

/**
 * Format file content with line numbers (Cursor-style)
 */
function formatFileWithLineNumbers(content: string, maxLines?: number): { formatted: string; lineCount: number; truncated: boolean } {
  const lines = content.split('\n');
  const lineCount = lines.length;
  const truncated = maxLines ? lineCount > maxLines : false;
  const linesToShow = truncated ? lines.slice(0, maxLines) : lines;

  const maxLineNumWidth = String(linesToShow.length).length;
  const formatted = linesToShow
    .map((line, i) => `${String(i + 1).padStart(maxLineNumWidth)}|${line}`)
    .join('\n');

  return {
    formatted: truncated ? `${formatted}\n... (truncated, ${lineCount - maxLines!} more lines)` : formatted,
    lineCount,
    truncated,
  };
}

/**
 * Get system info (cached after first call)
 */
async function getCachedSystemInfo(): Promise<{ os: string; os_version: string; arch: string; shell: string | null }> {
  if (cachedSystemInfo) {
    return cachedSystemInfo;
  }
  
  try {
    const info = await getSystemInfo();
    cachedSystemInfo = {
      os: info.os,
      os_version: info.os_version,
      arch: info.arch,
      shell: info.shell,
    };
    return cachedSystemInfo;
  } catch (error) {
    console.warn('[ContextBuilder] Failed to get system info:', error);
    return { os: 'unknown', os_version: 'unknown', arch: 'unknown', shell: null };
  }
}

/**
 * Build complete context for a user query
 * Follows Cursor-style format structure
 */
export async function buildQueryContext(
  userQuery: string,
  attachedFiles?: AttachedFile[],
  config?: ContextConfig,
  includeRules: boolean = true
): Promise<BuiltContext> {
  const sections: string[] = [];

  // 1. User/Workspace Info (Cursor: <user_info>)
  if (config) {
    const userInfo = buildUserInfo(config);
    if (userInfo) sections.push(userInfo);
  }

  // 2. Project Rules (from .aurora/*.md) - Similar to Cursor's <always_applied_workspace_rules>
  if (includeRules && config?.workspacePath) {
    const rules = config.projectRules || await loadProjectRules(config.workspacePath);
    const rulesSection = buildProjectRules(rules);
    if (rulesSection) sections.push(rulesSection);
  }

  // 3. Project Layout (Cursor: <project_layout>) - Persistent file map
  // This is CRITICAL for helping the agent understand project structure and use correct paths
  if (config?.includeProjectLayout !== false && config?.projectLayout) {
    const layoutSection = buildProjectLayout(config);
    if (layoutSection) sections.push(layoutSection);
  }

  // 4. IDE Context (open files, recent files) - Similar to Cursor's <additional_data>
  if (config) {
    const fileContext = buildFileContext(config);
    if (fileContext) sections.push(fileContext);
  }

  // 5. Attached Files (Cursor: <attached_files>)
  let filesWithContent: FileContent[] = [];
  let filesAsPathsOnly: string[] = [];

  if (attachedFiles && attachedFiles.length > 0) {
    const result = await buildAttachedFiles(attachedFiles);
    sections.push(result.section);
    filesWithContent = result.filesWithContent;
    filesAsPathsOnly = result.filesAsPathsOnly;
  }

  // 6. Build final context with user query at the end
  let formattedContext: string;

  if (sections.length > 0) {
    formattedContext = `${sections.join('\n\n')}

<user_query>
${userQuery}
</user_query>`;
  } else {
    formattedContext = userQuery;
  }

  return {
    formattedContext,
    filesWithContent,
    filesAsPathsOnly,
  };
}

/**
 * Generate project layout tree from workspace files
 * This creates a Cursor-style file tree representation
 * EXCLUDES: build artifacts, node_modules, .next, dist, etc.
 */
export function generateProjectLayout(files: FileNode[], workspacePath: string, maxDepth = MAX_TREE_DEPTH): string {
  if (!files || files.length === 0) return '';

  const lines: string[] = [];
  let fileCount = 0;
  let skippedFolders: string[] = [];

  // Add workspace root
  lines.push(`${workspacePath}/`);

  function shouldIgnore(name: string, isFolder: boolean): boolean {
    if (isFolder) {
      return IGNORED_FOLDERS.has(name);
    }
    
    // Check exact filename match
    if (IGNORED_FILES.has(name)) {
      return true;
    }
    
    // Check file extension
    const ext = name.includes('.') ? '.' + name.split('.').pop()?.toLowerCase() : '';
    if (ext && IGNORED_EXTENSIONS.has(ext)) {
      return true;
    }
    
    // Check wildcard patterns in IGNORED_FILES (e.g., '*.pyc')
    for (const pattern of IGNORED_FILES) {
      if (pattern.startsWith('*.')) {
        const patternExt = pattern.slice(1); // Remove '*'
        if (name.endsWith(patternExt)) {
          return true;
        }
      }
    }
    
    return false;
  }

  function processNode(node: FileNode, indent: string, depth: number): void {
    if (depth > maxDepth || fileCount > MAX_FILES_IN_TREE) return;

    const isFolder = node.type === 'folder';
    
    // Skip ignored folders/files
    if (shouldIgnore(node.name, isFolder)) {
      if (isFolder) {
        skippedFolders.push(node.name);
      }
      return;
    }

    const prefix = indent + '  ';
    
    if (isFolder) {
      lines.push(`${prefix}- ${node.name}/`);
      
      // Process children if folder has them
      if (node.children && node.children.length > 0) {
        // Sort: folders first, then files, alphabetically
        const sorted = [...node.children].sort((a, b) => {
          if (a.type === 'folder' && b.type !== 'folder') return -1;
          if (a.type !== 'folder' && b.type === 'folder') return 1;
          return a.name.localeCompare(b.name);
        });

        for (const child of sorted) {
          processNode(child, prefix, depth + 1);
        }
      }
    } else {
      lines.push(`${prefix}- ${node.name}`);
      fileCount++;
    }
  }

  // Sort root level: folders first, then files
  const sorted = [...files].sort((a, b) => {
    if (a.type === 'folder' && b.type !== 'folder') return -1;
    if (a.type !== 'folder' && b.type === 'folder') return 1;
    return a.name.localeCompare(b.name);
  });

  for (const node of sorted) {
    processNode(node, '', 1);
  }

  // Add note about skipped folders
  if (skippedFolders.length > 0) {
    lines.push('');
    lines.push(`Note: Excluded from tree: ${[...new Set(skippedFolders)].join(', ')}`);
  }

  if (fileCount >= MAX_FILES_IN_TREE) {
    lines.push(`  ... (truncated, showing first ${MAX_FILES_IN_TREE} files)`);
  }

  return lines.join('\n');
}

/**
 * Get current IDE context from stores
 * Includes project layout for first message in conversation
 */
export function getIDEContext(includeProjectLayout: boolean = true): ContextConfig {
  const workspaceState = useWorkspaceStore.getState();
  const editorState = useEditorStore.getState();

  // Get open tabs with more detail
  const openFiles = editorState.tabs.map((tab: any) => ({
    path: tab.path,
    isActive: tab.id === editorState.activeTabId,
    cursorLine: undefined, // Could add cursor tracking later
    totalLines: tab.content ? tab.content.split('\n').length : undefined,
  }));

  // Generate project layout from workspace files
  let projectLayout: string | undefined;
  if (includeProjectLayout && workspaceState.rootPath && workspaceState.files.length > 0) {
    projectLayout = generateProjectLayout(workspaceState.files, workspaceState.rootPath);
  }

  // Use cached system info if available, otherwise use basic detection
  let osInfo = 'unknown';
  let shellPath: string | undefined;
  
  if (cachedSystemInfo) {
    // Format like Cursor: "win32 10.0.26200"
    osInfo = `${cachedSystemInfo.os} ${cachedSystemInfo.os_version}`;
    shellPath = cachedSystemInfo.shell || undefined;
  } else if (typeof navigator !== 'undefined') {
    // Fallback to basic detection
    const platform = navigator.platform || '';
    const userAgent = navigator.userAgent || '';
    
    if (platform.includes('Win') || userAgent.includes('Windows')) {
      osInfo = 'win32';
    } else if (platform.includes('Mac') || userAgent.includes('Mac')) {
      osInfo = 'darwin';
    } else if (platform.includes('Linux') || userAgent.includes('Linux')) {
      osInfo = 'linux';
    } else {
      osInfo = platform;
    }
  }

  // Build config
  const config: ContextConfig = {
    osInfo,
    shellPath,
    workspacePath: workspaceState.rootPath || undefined,
    openFiles: openFiles.length > 0 ? openFiles : undefined,
    projectLayout,
    includeProjectLayout,
    systemInfo: cachedSystemInfo || undefined,
  };

  return config;
}

/**
 * Get IDE context without project layout (for follow-up messages)
 * The project layout is static and only needs to be sent once at conversation start
 */
export function getIDEContextLight(): ContextConfig {
  return getIDEContext(false);
}

/**
 * Initialize system info cache (call this early in app startup)
 */
export async function initializeSystemInfo(): Promise<void> {
  await getCachedSystemInfo();
  console.log('[ContextBuilder] System info cached:', cachedSystemInfo);
}

/**
 * Load project rules from .aurora/*.md files
 */
export async function loadProjectRules(workspacePath: string): Promise<ProjectRule[]> {
  const rules: ProjectRule[] = [];
  const rulesPath = workspacePath.includes('\\')
    ? `${workspacePath}\\${RULES_FOLDER}`
    : `${workspacePath}/${RULES_FOLDER}`;

  try {
    const entries = await readDirectory(rulesPath);

    // Filter for .md files (excluding threads folder content)
    const mdFiles = entries.filter(entry =>
      entry.is_file &&
      entry.name.endsWith('.md') &&
      !entry.path.includes('threads')
    );

    // Read each .md file
    for (const file of mdFiles) {
      try {
        const content = await readFileContent(file.path);
        rules.push({
          filename: file.name,
          content: content.trim(),
        });
      } catch (error) {
        console.warn(`[ContextBuilder] Failed to read rule file ${file.name}:`, error);
      }
    }

    if (rules.length > 0) {
      console.log(`[ContextBuilder] Loaded ${rules.length} project rule(s) from ${RULES_FOLDER}/`);
    }
  } catch (error) {
    // .aurora folder doesn't exist or can't be read - that's fine
    console.log(`[ContextBuilder] No project rules found (${RULES_FOLDER}/ not accessible)`);
  }

  return rules;
}

// Configuration
const MAX_FULL_CONTENT_FILES = 2; // Files beyond this get path-only treatment
const MAX_FILE_LINES = 500; // Truncate large files
const RULES_FOLDER = '.aurora'; // Folder containing project rules
const MAX_TREE_DEPTH = 6; // Maximum depth for project layout tree
const MAX_FILES_IN_TREE = 500; // Maximum files to show in tree (prevent huge trees)

// ============================================
// UNIFIED IGNORE SYSTEM FOR PROJECT LAYOUT
// Covers all major languages, frameworks, and build systems
// ============================================
const IGNORED_FOLDERS = new Set([
  // === VERSION CONTROL ===
  '.git',
  '.svn',
  '.hg',
  '.bzr',
  '_darcs',
  '.fossil',

  // === JAVASCRIPT/NODE.JS ===
  'node_modules',
  '.pnpm',
  '.npm',
  '.yarn',
  '.pnp',
  'bower_components',
  'jspm_packages',

  // === NEXT.JS / REACT ===
  '.next',
  '.docusaurus',
  '.gatsby',

  // === VUE / NUXT ===
  '.nuxt',
  '.output',
  '.vuepress',
  '.temp',

  // === ANGULAR ===
  '.angular',

  // === SVELTE ===
  '.svelte-kit',

  // === BUNDLERS & BUILD TOOLS ===
  'dist',
  'build',
  'out',
  'output',
  '.parcel-cache',
  '.rollup.cache',
  '.webpack',
  '.turbo',
  '.vercel',
  '.netlify',
  '.serverless',
  '.amplify',
  '.firebase',

  // === RUST ===
  'target',

  // === GO ===
  'vendor',
  'bin',
  'pkg',

  // === JAVA / KOTLIN / ANDROID ===
  '.gradle',
  '.idea',
  'gradle',
  '.m2',
  '.mvn',
  'classes',
  'libs',
  'intermediates',
  'generated',
  'outputs',
  'captures',
  '.cxx',
  '.externalNativeBuild',
  'jniLibs',
  'apk',
  'aab',

  // === C / C++ ===
  'cmake-build-debug',
  'cmake-build-release',
  'cmake-build-relwithdebinfo',
  'cmake-build-minsizerel',
  'CMakeFiles',
  'Debug',
  'Release',
  'x64',
  'x86',
  'Win32',
  'ARM',
  'ARM64',
  '.vs',
  'ipch',
  'obj',

  // === .NET / C# ===
  'bin',
  'obj',
  'packages',
  '.nuget',
  'TestResults',
  'AppPackages',
  'BundleArtifacts',

  // === PYTHON ===
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '.tox',
  '.nox',
  '.eggs',
  '*.egg-info',
  '.venv',
  'venv',
  'env',
  'ENV',
  '.env',
  '.pyenv',
  '.conda',
  'site-packages',
  'htmlcov',

  // === RUBY ===
  '.bundle',
  '.gem',

  // === PHP ===
  'vendor',

  // === SWIFT / IOS / XCODE ===
  'DerivedData',
  'Pods',
  '.build',
  'Carthage',
  'xcuserdata',
  '*.xcworkspace',

  // === FLUTTER / DART ===
  '.dart_tool',
  '.pub-cache',
  '.pub',

  // === ELIXIR ===
  '_build',
  'deps',
  '.elixir_ls',

  // === HASKELL ===
  '.stack-work',
  '.cabal-sandbox',

  // === SCALA / SBT ===
  'project/target',
  'project/project',

  // === TESTING & COVERAGE ===
  'coverage',
  '.nyc_output',
  '__snapshots__',
  '.jest',
  '.mocha',
  'test-results',
  'test-output',
  'allure-results',
  'allure-report',

  // === CACHES ===
  '.cache',
  '.temp',
  '.tmp',
  'tmp',
  'temp',
  'logs',
  'log',

  // === IDE / EDITOR ===
  '.idea',
  '.vscode',
  '.vs',
  '*.xcodeproj',
  '*.xcworkspace',
  '.settings',
  '.project',
  '.classpath',
  '.factorypath',
  'nbproject',
  '.nb-gradle',

  // === OS GENERATED ===
  '__MACOSX',
  '.Spotlight-V100',
  '.Trashes',
  'ehthumbs.db',
  '$RECYCLE.BIN',

  // === DOCKER ===
  '.docker',

  // === TERRAFORM ===
  '.terraform',
  '.terragrunt-cache',

  // === MISC BUILD ARTIFACTS ===
  'artifacts',
  'publish',
  '_site',
  'public/build',
  'static/build',
]);

// Files to exclude from project layout
const IGNORED_FILES = new Set([
  // === OS FILES ===
  '.DS_Store',
  '.DS_Store?',
  '._*',
  'Thumbs.db',
  'ehthumbs.db',
  'Desktop.ini',
  '$RECYCLE.BIN',

  // === ENVIRONMENT FILES ===
  '.env',
  '.env.local',
  '.env.development',
  '.env.development.local',
  '.env.test',
  '.env.test.local',
  '.env.production',
  '.env.production.local',
  '.envrc',

  // === LOCK FILES (huge, not useful for context) ===
  'pnpm-lock.yaml',
  'package-lock.json',
  'yarn.lock',
  'bun.lockb',
  'Cargo.lock',
  'Gemfile.lock',
  'composer.lock',
  'poetry.lock',
  'Pipfile.lock',
  'pubspec.lock',
  'packages.lock.json',
  'paket.lock',
  'mix.lock',
  'shrinkwrap.yaml',
  'pnpm-workspace.yaml',

  // === BUILD MANIFESTS ===
  '.gradle',
  'gradlew',
  'gradlew.bat',
  'mvnw',
  'mvnw.cmd',

  // === COMPILED FILES ===
  '*.pyc',
  '*.pyo',
  '*.class',
  '*.dll',
  '*.exe',
  '*.o',
  '*.obj',
  '*.so',
  '*.dylib',
  '*.a',
  '*.lib',
  '*.pdb',
  '*.idb',

  // === LOGS ===
  '*.log',
  'npm-debug.log*',
  'yarn-debug.log*',
  'yarn-error.log*',
  'lerna-debug.log*',
  '.pnpm-debug.log*',

  // === MISC ===
  '.gitattributes',
  '.editorconfig',
  '.prettierignore',
  '.eslintignore',
  '.dockerignore',
  '.npmignore',
  '.yarnignore',
]);

// File extensions to always ignore (binary/compiled)
const IGNORED_EXTENSIONS = new Set([
  // Compiled
  '.pyc', '.pyo', '.pyd',
  '.class', '.jar', '.war', '.ear',
  '.dll', '.exe', '.msi', '.msm', '.msp',
  '.o', '.obj', '.a', '.lib', '.so', '.dylib',
  '.ko', '.elf',
  // Debug
  '.pdb', '.idb', '.ilk',
  // Archives
  '.zip', '.tar', '.gz', '.bz2', '.xz', '.7z', '.rar',
  '.tgz', '.tbz2', '.txz',
  // Images (usually not needed in tree)
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.icns',
  '.webp', '.svg', '.tiff', '.tif', '.psd', '.ai',
  // Fonts
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  // Media
  '.mp3', '.mp4', '.wav', '.ogg', '.webm', '.avi', '.mov', '.mkv',
  '.flac', '.aac', '.m4a',
  // Database
  '.db', '.sqlite', '.sqlite3', '.mdb',
  // Maps
  '.map',
]);

// Cache system info to avoid repeated Tauri calls
let cachedSystemInfo: { os: string; os_version: string; arch: string; shell: string | null } | null = null;

export default {
  buildQueryContext,
  getIDEContext,
  getIDEContextLight,
  initializeSystemInfo,
  loadProjectRules,
  generateProjectLayout,
  MAX_FULL_CONTENT_FILES,
  MAX_FILE_LINES,
  RULES_FOLDER,
};
