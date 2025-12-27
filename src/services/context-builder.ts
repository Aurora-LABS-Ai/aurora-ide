/**
 * Context Builder Service
 * Builds Cursor-style structured context for AI queries
 * Includes user info, workspace state, attached files, IDE context, and project rules
 */

import { readFileContent, readDirectory } from '../lib/tauri';
import type { AttachedFile } from '../components/chat/ChatInput';
import { useWorkspaceStore } from '../store/useWorkspaceStore';
import { useEditorStore } from '../store/useEditorStore';

// Configuration
const MAX_FULL_CONTENT_FILES = 2; // Files beyond this get path-only treatment
const MAX_FILE_LINES = 500; // Truncate large files
const RULES_FOLDER = '.aurora'; // Folder containing project rules

export interface ProjectRule {
  filename: string;
  content: string;
}

export interface ContextConfig {
  osInfo?: string;
  workspacePath?: string;
  openFiles?: Array<{ path: string; isActive: boolean; cursorLine?: number }>;
  recentFiles?: string[];
  projectTree?: string;
  projectRules?: ProjectRule[]; // Rules from .aurora/*.md
}

export interface FileContent {
  path: string;
  name: string;
  content: string;
  lineCount: number;
  truncated: boolean;
}

export interface BuiltContext {
  formattedContext: string;
  filesWithContent: FileContent[];
  filesAsPathsOnly: string[];
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
 * Build user info section
 */
function buildUserInfo(config: ContextConfig): string {
  const parts: string[] = [];

  if (config.osInfo) {
    parts.push(`OS: ${config.osInfo}`);
  }
  if (config.workspacePath) {
    parts.push(`Workspace: ${config.workspacePath}`);
  }

  if (parts.length === 0) return '';

  return `<user_info>
${parts.join('\n')}
</user_info>`;
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
 * Build complete context for a user query
 */
export async function buildQueryContext(
  userQuery: string,
  attachedFiles?: AttachedFile[],
  config?: ContextConfig,
  includeRules: boolean = true
): Promise<BuiltContext> {
  const sections: string[] = [];

  // 1. User/Workspace Info
  if (config) {
    const userInfo = buildUserInfo(config);
    if (userInfo) sections.push(userInfo);
  }

  // 2. Project Rules (from .aurora/*.md)
  if (includeRules && config?.workspacePath) {
    const rules = config.projectRules || await loadProjectRules(config.workspacePath);
    const rulesSection = buildProjectRules(rules);
    if (rulesSection) sections.push(rulesSection);
  }

  // 3. IDE Context (open files, recent files)
  if (config) {
    const fileContext = buildFileContext(config);
    if (fileContext) sections.push(fileContext);
  }

  // 4. Attached Files
  let filesWithContent: FileContent[] = [];
  let filesAsPathsOnly: string[] = [];

  if (attachedFiles && attachedFiles.length > 0) {
    const result = await buildAttachedFiles(attachedFiles);
    sections.push(result.section);
    filesWithContent = result.filesWithContent;
    filesAsPathsOnly = result.filesAsPathsOnly;
  }

  // 5. Build final context
  let formattedContext: string;

  if (sections.length > 0) {
    formattedContext = `${sections.join('\n\n')}

${userQuery}`;
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
 * Get current IDE context from stores
 */
export function getIDEContext(): ContextConfig {
  const workspaceState = useWorkspaceStore.getState();
  const editorState = useEditorStore.getState();

  // Get open tabs
  const openFiles = editorState.tabs.map((tab: any) => ({
    path: tab.path,
    isActive: tab.path === editorState.activeTabId,
    cursorLine: undefined, // Could add cursor tracking later
  }));

  // Build config
  const config: ContextConfig = {
    osInfo: typeof navigator !== 'undefined' ? navigator.platform : undefined,
    workspacePath: workspaceState.rootPath || undefined,
    openFiles: openFiles.length > 0 ? openFiles : undefined,
  };

  return config;
}

export default {
  buildQueryContext,
  getIDEContext,
  loadProjectRules,
  MAX_FULL_CONTENT_FILES,
  MAX_FILE_LINES,
  RULES_FOLDER,
};
