/**
 * Context Builder Service
 * Builds Cursor-style structured context for AI queries
 * Includes user info, workspace state, attached files, IDE context, project rules, and project layout
 * 
 * Implements the Cursor format structure:
 * - <user_info> - OS, Shell, Workspace Path (first message only)
 * - <git_status> - Current git status snapshot (first message only)
 * - <project_rules> - Rules from .aurora/*.md files
 * - <project_layout> - Static snapshot of file tree (persistent file map, first message only)
 * - <open_and_recently_viewed_files> - Open/recent files (every message)
 * - <attached_files> - Files attached with @ syntax
 * 
 * Follow-up messages are lightweight: only changed state + user query.
 */
import type { AttachedFile } from "../components/chat/ChatInput";
import { isImageFilePath } from "../lib/file-utils";
import { auroraInvoke as invoke } from "../lib/runtime";
import { getSystemInfo, readDirectory, readFileContent } from "../lib/tauri";
import { useEditorStore } from "../store/useEditorStore";
import { useWorkspaceStore } from "../store/useWorkspaceStore";
import type { FileNode } from "../types";
import type { Tab } from "../types";

interface GitFileStatus {
  path: string;
  status: string;
  staged: boolean;
}

export interface BuiltContext {
  filesAsPathsOnly: string[];
  filesWithContent: FileContent[];
  /**
   * Legacy: full enriched blob = `ideContext` + `<user_query>...</user_query>`.
   * Kept for callers that send the whole thing as a single LLM user message.
   * Prefer the `ideContext` + `userQuery` pair below for new code so the
   * persistence layer can store the clean user text separately from the
   * enrichment.
   */
  formattedContext: string;
  /**
   * The IDE/runtime enrichment block ONLY — execution_mode, user_info,
   * project_rules, project_layout, agent_skills, open_files,
   * attached_context, etc. — without the wrapping `<user_query>` element.
   * `null` when there is no enrichment (e.g. follow-up message with no open
   * files and no rules).
   */
  ideContext: string | null;
  /**
   * The clean text that will be wrapped in `<user_query>` for the LLM and
   * shown verbatim in the chat bubble.
   */
  userQuery: string;
}

export interface ContextConfig {
  includeFullContext?: boolean; // true for first message, false for follow-ups
  includeProjectLayout?: boolean; // Whether to include project layout (default: true for first message)
  openFiles?: Array<{ path: string; isActive: boolean; cursorLine?: number; totalLines?: number }>;
  osInfo?: string; // Full OS info like "win32 10.0.26200"
  projectLayout?: string; // Pre-built project tree string
  projectRules?: ProjectRule[]; // Rules from .aurora/*.md
  recentFiles?: string[];
  shellPath?: string; // Default shell path
  skillCatalog?: string; // Pre-formatted skill catalog (first message only)
  skillReferences?: string; // Pre-formatted active/required skill references (when skills are attached)
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

  // First N files get full content, remaining files are provided as path-only references.
  const filesForFullContent = attachedFiles.slice(0, MAX_FULL_CONTENT_FILES);
  filesAsPathsOnly.push(...attachedFiles.slice(MAX_FULL_CONTENT_FILES).map((file) => file.path));

  // Read full-content files in parallel, while preserving the input order in output.
  const fullFileResults = await Promise.all(
    filesForFullContent.map(async (file) => {
      try {
        if (isImageFilePath(file.path)) {
          return {
            ok: true as const,
            kind: 'image' as const,
            file,
          };
        }

        const content = await readFileContent(file.path);
        const { formatted, lineCount, truncated } = formatFileWithLineNumbers(content, MAX_FILE_LINES);
        return {
          ok: true as const,
          kind: 'text' as const,
          file,
          content,
          formatted,
          lineCount,
          truncated,
        };
      } catch (error) {
        return {
          ok: false as const,
          file,
          error,
        };
      }
    })
  );

  for (const result of fullFileResults) {
    if (result.ok) {
      if (result.kind === 'image') {
        filesAsPathsOnly.push(result.file.path);
        fileSections.push(`<image_file path="${result.file.path}" note="Binary image attachment">
User attached this image file. Treat it as image context rather than text content. Use the path for tools, and inspect it directly only if the active model/provider supports vision.
</image_file>`);
        continue;
      }

      filesWithContent.push({
        path: result.file.path,
        name: result.file.name,
        content: result.content,
        lineCount: result.lineCount,
        truncated: result.truncated,
      });

      fileSections.push(`<file path="${result.file.path}" lines="${result.lineCount}"${result.truncated ? ' truncated="true"' : ''}>
${result.formatted}
</file>`);
    } else {
      fileSections.push(`<file path="${result.file.path}" error="true">
Failed to read file: ${result.error}
</file>`);
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
 * Build open/recent files section (Cursor-style lightweight format)
 * This is sent with EVERY message (it reflects current IDE state that may change)
 */
function buildOpenAndRecentFiles(config: ContextConfig): string {
  const lines: string[] = [];

  if (config.openFiles && config.openFiles.length > 0) {
    for (const f of config.openFiles) {
      let info = f.path;
      if (f.isActive) {
        info += f.cursorLine ? ` (active, cursor at line ${f.cursorLine})` : ' (active)';
      }
      lines.push(`- ${info}`);
    }
  }

  if (config.recentFiles && config.recentFiles.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push('Recently viewed:');
    for (const f of config.recentFiles.slice(0, 5)) {
      lines.push(`- ${f}`);
    }
  }

  if (lines.length === 0) {
    return `<open_and_recently_viewed_files>
User currently doesn't have any open files in their IDE.

Note: these files may or may not be relevant to the current conversation.
</open_and_recently_viewed_files>`;
  }

  return `<open_and_recently_viewed_files>
${lines.join('\n')}

Note: these files may or may not be relevant to the current conversation.
</open_and_recently_viewed_files>`;
}

/**
 * Build git status section (snapshot at conversation start)
 * Only included in first message - doesn't change conceptually during a conversation turn
 */
async function buildGitStatus(workspacePath: string): Promise<string> {
  try {
    const isRepo = await invoke<boolean>('git_is_repository', { path: workspacePath });
    if (!isRepo) return '';

    const statusFiles = await invoke<GitFileStatus[]>('git_get_status', { path: workspacePath });
    let currentBranch = '';
    try {
      currentBranch = await invoke<string>('git_current_branch', { path: workspacePath });
    } catch {
      currentBranch = 'unknown';
    }

    if (!statusFiles || statusFiles.length === 0) {
      return `<git_status>
Git repo: ${workspacePath}
Branch: ${currentBranch}
Working tree clean.
</git_status>`;
    }

    const statusLines = statusFiles.map(f => {
      const prefix = f.staged ? ' ' : '';
      const statusChar = f.status === 'modified' ? 'M' : f.status === 'added' ? 'A' : f.status === 'deleted' ? 'D' : f.status === 'untracked' ? '?' : f.status.charAt(0).toUpperCase();
      return `${prefix}${statusChar} ${f.path}`;
    });

    return `<git_status>
This is the git status at conversation start. This snapshot does NOT update during the conversation.

Git repo: ${workspacePath}
Branch: ${currentBranch}
${statusLines.join('\n')}
</git_status>`;
  } catch (error) {
    console.warn('[ContextBuilder] Failed to get git status:', error);
    return '';
  }
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
 * 
 * First message: heavy context (user_info, git_status, rules, project_layout, open_files, attached_files)
 * Follow-up messages: lightweight (open_files + user_query only)
 */
export async function buildQueryContext(
  userQuery: string,
  attachedFiles?: AttachedFile[],
  config?: ContextConfig,
  includeRules: boolean = true
): Promise<BuiltContext> {
  const sections: string[] = [];
  const isFirstMessage = config?.includeFullContext !== false;

  // === FIRST MESSAGE ONLY: Heavy context ===
  if (isFirstMessage) {
    // 1. User/Workspace Info (Cursor: <user_info>) - only first message
    if (config) {
      const userInfo = buildUserInfo(config);
      if (userInfo) sections.push(userInfo);
    }

    // 2. Git Status snapshot (Cursor: <git_status>) - only first message
    if (config?.workspacePath) {
      const gitStatus = await buildGitStatus(config.workspacePath);
      if (gitStatus) sections.push(gitStatus);
    }

    // 3. Project Rules (from .aurora/*.md) - Similar to Cursor's <always_applied_workspace_rules>
    if (includeRules && config?.workspacePath) {
      const rules = config.projectRules || await loadProjectRules(config.workspacePath);
      const rulesSection = buildProjectRules(rules);
      if (rulesSection) sections.push(rulesSection);
    }

    // 4. Project Layout (Cursor: <project_layout>) - Persistent file map, first message only
    if (config?.includeProjectLayout !== false && config?.projectLayout) {
      const layoutSection = buildProjectLayout(config);
      if (layoutSection) sections.push(layoutSection);
    }

    // 5. Skill Catalog (Cursor: <agent_skills>) - descriptions + paths, first message only
    // Agent reads full skill content on demand via file_read
    if (config?.skillCatalog) {
      sections.push(config.skillCatalog);
    }
  }

  // === EVERY MESSAGE: Lightweight context ===

  // 6. Open/Recent Files (Cursor: <open_and_recently_viewed_files>) - every message
  if (config) {
    const openFiles = buildOpenAndRecentFiles(config);
    if (openFiles) sections.push(openFiles);
  }

  // 7. Skill references - only when user attaches skills or skills are auto-matched
  // Sends name + path only, agent reads full content via file_read
  if (config?.skillReferences) {
    sections.push(config.skillReferences);
  }

  // 8. Attached Files (Cursor: <attached_files>) - whenever present
  let filesWithContent: FileContent[] = [];
  let filesAsPathsOnly: string[] = [];

  if (attachedFiles && attachedFiles.length > 0) {
    const result = await buildAttachedFiles(attachedFiles);
    sections.push(result.section);
    filesWithContent = result.filesWithContent;
    filesAsPathsOnly = result.filesAsPathsOnly;
  }

  // 7. Build final context with user query at the end
  const ideContext = sections.length > 0 ? sections.join('\n\n') : null;

  let formattedContext: string;
  if (ideContext) {
    formattedContext = `${ideContext}\n\n<user_query>\n${userQuery}\n</user_query>`;
  } else {
    formattedContext = userQuery;
  }

  return {
    formattedContext,
    ideContext,
    userQuery,
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
  const skippedFolders: string[] = [];

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
 * Get full IDE context for first message in conversation
 * Includes: user_info, git_status, project_layout, project_rules, open_files
 */
export function getIDEContext(includeProjectLayout: boolean = true): ContextConfig {
  const workspaceState = useWorkspaceStore.getState();
  const editorState = useEditorStore.getState();

  const openFiles = editorState.tabs.map((tab: Tab) => ({
    path: tab.path,
    isActive: tab.id === editorState.activeTabId,
    cursorLine: undefined,
    totalLines: tab.content ? tab.content.split('\n').length : undefined,
  }));

  let projectLayout: string | undefined;
  if (includeProjectLayout && workspaceState.rootPath && workspaceState.files.length > 0) {
    projectLayout = generateProjectLayout(workspaceState.files, workspaceState.rootPath);
  }

  let osInfo = 'unknown';
  let shellPath: string | undefined;
  
  if (cachedSystemInfo) {
    osInfo = `${cachedSystemInfo.os} ${cachedSystemInfo.os_version}`;
    shellPath = cachedSystemInfo.shell || undefined;
  } else if (typeof navigator !== 'undefined') {
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

  return {
    includeFullContext: true,
    osInfo,
    shellPath,
    workspacePath: workspaceState.rootPath || undefined,
    openFiles: openFiles.length > 0 ? openFiles : undefined,
    projectLayout,
    includeProjectLayout,
    systemInfo: cachedSystemInfo || undefined,
  };
}

/**
 * Get lightweight IDE context for follow-up messages
 * Only includes: open_files (what may have changed)
 * Does NOT re-send: user_info, git_status, project_layout, rules (already in Turn 1)
 */
export function getIDEContextLight(): ContextConfig {
  const workspaceState = useWorkspaceStore.getState();
  const editorState = useEditorStore.getState();

  const openFiles = editorState.tabs.map((tab: Tab) => ({
    path: tab.path,
    isActive: tab.id === editorState.activeTabId,
    cursorLine: undefined,
    totalLines: tab.content ? tab.content.split('\n').length : undefined,
  }));

  return {
    includeFullContext: false,
    workspacePath: workspaceState.rootPath || undefined,
    openFiles: openFiles.length > 0 ? openFiles : undefined,
  };
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
  } catch {
    // .aurora folder doesn't exist or can't be read - that's fine
    console.log(`[ContextBuilder] No project rules found (${RULES_FOLDER}/ not accessible)`);
  }

  return rules;
}

/**
 * Build a standalone `<attached_context>` XML block describing skills/rules
 * the user explicitly attached to a message. Returns `null` when there are
 * no attachments worth surfacing.
 *
 * Use this when you want the attachment metadata to live in the
 * `ideContext` sidecar (so the chat bubble stays clean) instead of being
 * folded into the user-typed text.
 */
export function buildAttachedContextBlock(
  promptAttachments?: Array<{ type: string; title: string; key: string }>,
): string | null {
  if (!promptAttachments || promptAttachments.length === 0) {
    return null;
  }

  const skills = promptAttachments.filter((a) => a.type === 'skill');
  const rules = promptAttachments.filter((a) => a.type === 'rule');

  if (skills.length === 0 && rules.length === 0) {
    return null;
  }

  const lines: string[] = [];
  lines.push('<attached_context description="The user explicitly attached the following skills/rules to this message. Refer to them by name and use the corresponding required_skills/project_rules content.">');

  if (skills.length > 0) {
    lines.push(`  Skills: ${skills.map((s) => s.title).join(', ')}`);
  }

  if (rules.length > 0) {
    lines.push(`  Rules: ${rules.map((r) => r.title).join(', ')}`);
  }

  lines.push('</attached_context>');

  return lines.join('\n');
}

/**
 * @deprecated Folds the attached-context block into the user-typed text,
 * which leaks XML into the chat bubble when a thread is reloaded. Prefer
 * [`buildAttachedContextBlock`] and pass the block in the `ideContext`
 * sidecar passed to `agent.chat`.
 *
 * Kept for callers that still rely on the legacy single-string flow.
 */
export function enrichUserQueryWithAttachments(
  userQuery: string,
  promptAttachments?: Array<{ type: string; title: string; key: string }>,
): string {
  const block = buildAttachedContextBlock(promptAttachments);
  return block ? `${block}\n\n${userQuery}` : userQuery;
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
  buildGitStatus,
  MAX_FULL_CONTENT_FILES,
  MAX_FILE_LINES,
  RULES_FOLDER,
};
