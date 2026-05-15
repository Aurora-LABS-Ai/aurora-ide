/**
 * Shared types for the tool-timeline subsystem.
 *
 * Each rich-result renderer (workspace_tree, grep, browser_scroll, …)
 * has its own data shape. Keeping the interfaces here lets the parser
 * (`useToolResultParser`) and the views share a single source of truth
 * without circular imports.
 */

export interface FileListEntry {
  name: string;
  type: "file" | "directory";
  path: string;
}

export interface MultiFileEntry {
  path: string;
  success: boolean;
  lines?: number;
  error?: string;
  content?: string;
}

export interface WorkspaceTreeNode {
  name: string;
  type: "file" | "directory" | string;
  path?: string;
  children?: WorkspaceTreeNode[];
  lineCount?: number;
  size?: number;
  largeFile?: boolean;
}

export interface WorkspaceTreeStats {
  filesRead?: number;
  filesSkipped?: number;
  included?: boolean;
}

export interface WorkspaceTreeData {
  rootPath?: string;
  tree: WorkspaceTreeNode[];
  stats?: WorkspaceTreeStats;
}

export interface GrepMatch {
  file: string;
  line_number: number;
  content?: string;
  before_context?: string[];
  after_context?: string[];
}

export interface GrepData {
  matches: GrepMatch[];
  pattern?: string;
  totalMatches?: number;
  truncated?: boolean;
}

export interface WebSearchResultItem {
  title?: string;
  url?: string;
  snippet?: string;
  description?: string;
  source?: string;
}

export interface WebSearchData {
  action: "search" | "fetch" | string;
  query?: string;
  url?: string;
  results?: WebSearchResultItem[];
  fetchedTitle?: string;
  fetchedUrl?: string;
}

export interface BrowserScrollResult {
  mode?: "direction" | "to_selector" | string;
  direction?: string;
  selector?: string;
  deltaY?: number;
  before?: { x: number; y: number };
  after?: { x: number; y: number };
  viewport?: { width: number; height: number; documentHeight: number };
  atTop?: boolean;
  atBottom?: boolean;
}

export interface ShellOutputData {
  command?: string;
  cwd?: string;
  exitCode?: number | null;
  mode?: "inline" | "terminal";
  output?: string | null;
  success?: boolean;
}

export interface SearchReplaceData {
  oldString?: string;
  newString?: string;
}
