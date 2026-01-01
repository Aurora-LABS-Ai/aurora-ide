/**
 * THEME ARCHITECTURE NOTICE:
 * 
 * This project uses a centralized theme system. DO NOT use hardcoded colors.
 * 
 * Instead of:
 *   - Hardcoded hex values: #ff0000, #1a1a1a
 *   - Hardcoded RGB values: rgb(255, 0, 0)
 *   - Tailwind arbitrary colors: bg-[#1a1a1a], text-[#ff0000]
 * 
 * Use theme tokens via CSS variables:
 *   - CSS: var(--aurora-{category}-{token})
 *   - Tailwind: bg-[var(--aurora-editor-background)]
 *   - Component styles: style={{ background: 'var(--aurora-sidebar-background)' }}
 * 
 * Available categories: editor, sidebar, chat, terminal, statusBar, titleBar, common
 * 
 * See: DOCS/theme-dev.md for full token reference
 * See: src/types/theme.ts for TypeScript interfaces
 * See: src/services/theme-service.ts for theme utilities
 */

import React, { useState, useEffect, useMemo, useRef } from 'react';
import {
  ChevronRight,
  Check,
  X,
  Loader2,
  FileCode,
  Maximize2,
  Minimize2,
  ArrowRight,
  Folder,
  File,
  LayoutGrid,
} from 'lucide-react';
import clsx from 'clsx';
import { twMerge } from 'tailwind-merge';
import { motion } from 'framer-motion';
import type { ToolCall } from '../../types';
import { getIconName, getIconUrl } from '../../lib/material-icon-theme';
import { ShimmerText } from '../ui/ShimmerText';

// --- Utility ---
function cn(...inputs: (string | undefined | null | false)[]) {
  return twMerge(clsx(inputs));
}

// --- 1. File Explorer Component ---
interface FileExplorerProps {
  files: Array<{ name: string; type: 'file' | 'directory'; path: string }>;
}

const FileExplorerView: React.FC<FileExplorerProps> = ({ files }) => {
  const [isExpanded, setIsExpanded] = useState(false);

  const sortedFiles = useMemo(() => {
    return [...files].sort((a, b) => {
      if (!a?.name || !b?.name) return 0; // Safety check
      if (a.type === b.type) return a.name.localeCompare(b.name);
      return a.type === 'directory' ? -1 : 1;
    });
  }, [files]);

  const displayedFiles = isExpanded ? sortedFiles : sortedFiles.slice(0, 6);
  const remainingCount = sortedFiles.length - 6;

  return (
    <div className="mt-2 rounded-lg border border-border bg-sidebar overflow-hidden">
      <div className="flex items-center justify-between border-b border-border bg-sidebar px-3 py-2">
        <div className="flex items-center gap-2">
          <LayoutGrid size={12} className="text-text-secondary" />
          <span className="text-[10px] font-medium text-text-secondary uppercase tracking-wider">
            Directory Listing
          </span>
        </div>
        <span className="text-[10px] text-text-disabled font-mono">
          {files.length} items
        </span>
      </div>

      <div className="p-2 grid grid-cols-1 sm:grid-cols-2 gap-2">
        {displayedFiles.map((file, idx) => (
          <div key={idx} className="flex items-center gap-2 rounded-md bg-input px-2 py-1.5 border border-border">
            {file.type === 'directory' ? (
              <Folder size={14} className="text-blue-400/80 fill-blue-400/10" />
            ) : (
              <File size={14} className="text-text-secondary" />
            )}
            <span className={cn(
              "truncate text-[11px]",
              file.type === 'directory' ? "text-text-primary font-medium" : "text-text-secondary"
            )}>
              {file.name}
            </span>
          </div>
        ))}
      </div>

      {!isExpanded && remainingCount > 0 && (
        <button
          onClick={(e) => { e.stopPropagation(); setIsExpanded(true); }}
          className="w-full border-t border-border bg-input/50 py-1.5 text-center text-[10px] text-text-secondary hover:text-text-primary transition-colors"
        >
          + {remainingCount} more items...
        </button>
      )}

      {isExpanded && files.length > 6 && (
        <button
          onClick={(e) => { e.stopPropagation(); setIsExpanded(false); }}
          className="w-full border-t border-border bg-input/50 py-1.5 text-center font-mono text-[10px] text-text-secondary hover:text-text-primary transition-colors"
        >
          Show less
        </button>
      )}
    </div>
  );
};

// --- 1.5. Multi-File Read Results Component ---
interface MultiFileResultsProps {
  files: Array<{
    path: string;
    success: boolean;
    lines?: number;
    error?: string;
    content?: string;
  }>;
}

const MultiFileResultsView: React.FC<MultiFileResultsProps> = ({ files }) => {
  const handleFileClick = async (file: { path: string; success: boolean; content?: string }) => {
    if (!file.success || !file.content) return;

    try {
      const { useEditorStore } = await import('../../store/useEditorStore');
      const { resolvePath } = await import('../../tools/utils/path-resolver');

      // Resolve full path
      const fullPath = resolvePath(file.path);
      const filename = fullPath.split(/[/\\]/).pop() || file.path;

      // Detect language from extension
      const ext = filename.split('.').pop()?.toLowerCase() || '';
      const langMap: Record<string, string> = {
        'ts': 'typescript', 'tsx': 'typescript',
        'js': 'javascript', 'jsx': 'javascript',
        'json': 'json', 'css': 'css', 'scss': 'scss',
        'html': 'html', 'md': 'markdown',
        'rs': 'rust', 'toml': 'toml',
        'yaml': 'yaml', 'yml': 'yaml',
        'py': 'python', 'go': 'go',
      };
      const language = langMap[ext] || 'plaintext';

      // Open in editor
      useEditorStore.getState().openFile(fullPath, filename, file.content, language);
    } catch (error) {
      console.error('Failed to open file:', error);
    }
  };

  return (
    <div className="mt-2 rounded-lg border border-border bg-sidebar overflow-hidden">
      <div className="flex items-center justify-between border-b border-border bg-sidebar px-3 py-2">
        <div className="flex items-center gap-2">
          <FileCode size={12} className="text-text-secondary" />
          <span className="text-[10px] font-medium text-text-secondary uppercase tracking-wider">
            Files Read
          </span>
        </div>
        <span className="text-[10px] text-text-disabled font-mono">
          {files.length} files
        </span>
      </div>

      <div className="p-2 space-y-1">
        {files.map((file, idx) => (
          <button
            key={idx}
            onClick={() => handleFileClick(file)}
            disabled={!file.success}
            className={cn(
              "w-full flex items-center justify-between gap-2 rounded-md px-3 py-2 border transition-all",
              file.success
                ? "bg-emerald-500/[0.03] border-emerald-500/20 hover:bg-emerald-500/[0.08] hover:border-emerald-500/30 cursor-pointer"
                : "bg-red-500/[0.03] border-red-500/20 cursor-not-allowed opacity-60"
            )}
          >
            <div className="flex items-center gap-2 min-w-0 flex-1">
              {file.success ? (
                <Check size={12} className="text-emerald-400 flex-shrink-0" />
              ) : (
                <X size={12} className="text-red-400 flex-shrink-0" />
              )}
              <span className="truncate font-mono text-[11px] text-text-secondary text-left">
                {file.path}
              </span>
            </div>
            <div className="flex items-center gap-2 flex-shrink-0">
              {file.success && file.lines !== undefined && (
                <span className="text-[10px] text-zinc-500 font-mono">
                  {file.lines} lines
                </span>
              )}
              {file.error && (
                <span className="text-[10px] text-red-400 font-mono truncate max-w-[150px]">
                  {file.error}
                </span>
              )}
            </div>
          </button>
        ))}
      </div>
    </div>
  );
};

// --- 1.6. Aurora Search Results Component ---
interface AuroraSearchResultsProps {
  results: Array<{
    filePath: string;
    relativePath: string;
    fileName: string;
    startLine: number;
    endLine: number;
    chunkType: string;
    symbolName: string | null;
    content: string;
    score: number;
    matchType: string;
  }>;
}

const AuroraSearchResultsView: React.FC<AuroraSearchResultsProps> = ({ results }) => {
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null);
  const [isExpanded, setIsExpanded] = useState(false);

  const handleResultClick = async (result: AuroraSearchResultsProps['results'][0]) => {
    try {
      const { useEditorStore } = await import('../../store/useEditorStore');
      const { resolvePath } = await import('../../tools/utils/path-resolver');
      const { readFileContent } = await import('../../lib/tauri');

      // Resolve full path
      const fullPath = resolvePath(result.filePath);

      // Read file content
      const content = await readFileContent(fullPath);

      // Detect language from extension
      const ext = result.fileName.split('.').pop()?.toLowerCase() || '';
      const langMap: Record<string, string> = {
        'ts': 'typescript', 'tsx': 'typescript',
        'js': 'javascript', 'jsx': 'javascript',
        'json': 'json', 'css': 'css', 'scss': 'scss',
        'html': 'html', 'md': 'markdown',
        'rs': 'rust', 'toml': 'toml',
        'yaml': 'yaml', 'yml': 'yaml',
        'py': 'python', 'go': 'go',
      };
      const language = langMap[ext] || 'plaintext';

      // Open in editor
      useEditorStore.getState().openFile(fullPath, result.fileName, content, language);
    } catch (error) {
      console.error('Failed to open file:', error);
    }
  };

  // Format chunk type for display
  const formatChunkType = (type: string) => {
    const typeMap: Record<string, { label: string; color: string }> = {
      'function': { label: 'fn', color: 'text-purple-400' },
      'class': { label: 'class', color: 'text-yellow-400' },
      'struct': { label: 'struct', color: 'text-orange-400' },
      'interface': { label: 'iface', color: 'text-cyan-400' },
      'enum': { label: 'enum', color: 'text-green-400' },
      'implementation': { label: 'impl', color: 'text-blue-400' },
      'module': { label: 'mod', color: 'text-pink-400' },
      'imports': { label: 'import', color: 'text-gray-400' },
      'constant': { label: 'const', color: 'text-amber-400' },
      'type_def': { label: 'type', color: 'text-teal-400' },
      'block': { label: 'block', color: 'text-zinc-400' },
      'comment': { label: 'doc', color: 'text-emerald-400' },
    };
    return typeMap[type.toLowerCase()] || { label: type, color: 'text-zinc-400' };
  };

  const isLongContent = results.length > 3;

  return (
    <div className="relative mt-2 overflow-hidden">
      {/* Scrollable results container - matches CodeView styling */}
      <div 
        className={cn(
          "overflow-y-auto overflow-x-hidden scrollbar-thin scrollbar-track-transparent scrollbar-thumb-transparent hover:scrollbar-thumb-border transition-colors",
          isExpanded ? "max-h-none" : "max-h-[150px]"
        )}
      >
        {results.map((result, idx) => {
          const chunkInfo = formatChunkType(result.chunkType);
          const isResultExpanded = expandedIndex === idx;
          const scorePercent = Math.round(result.score * 100);
          
          return (
            <div key={idx} className="group border-b border-border/30 last:border-b-0">
              {/* Result Row - Using div instead of button to avoid nesting issues */}
              <div
                onClick={() => handleResultClick(result)}
                onKeyDown={(e) => e.key === 'Enter' && handleResultClick(result)}
                role="button"
                tabIndex={0}
                className="w-full flex items-center gap-2 px-2 py-1.5 hover:bg-input/30 transition-colors cursor-pointer"
              >
                {/* File Icon */}
                <img
                  src={getIconUrl(getIconName(result.fileName, false))}
                  alt=""
                  className="w-3.5 h-3.5 flex-shrink-0"
                />
                
                {/* File Info - Compact */}
                <div className="flex-1 min-w-0 flex items-center gap-2">
                  <span className="text-[10px] font-medium text-text-primary truncate">
                    {result.fileName}
                  </span>
                  <span className="text-[9px] text-text-disabled font-mono flex-shrink-0">
                    :{result.startLine}
                  </span>
                </div>

                {/* Chunk Type Badge - Smaller */}
                <span className={cn(
                  "text-[7px] font-bold uppercase tracking-wider px-1 py-0.5 rounded bg-input/50",
                  chunkInfo.color
                )}>
                  {chunkInfo.label}
                </span>

                {/* Score Bar - Smaller */}
                <div className="flex items-center gap-1 flex-shrink-0">
                  <div className="w-6 h-0.5 bg-input rounded-full overflow-hidden">
                    <div 
                      className="h-full bg-primary/70 rounded-full"
                      style={{ width: `${scorePercent}%` }}
                    />
                  </div>
                  <span className="text-[8px] text-text-disabled font-mono w-5 text-right">
                    {scorePercent}%
                  </span>
                </div>

                {/* Expand Toggle - Using span with role instead of nested button */}
                <span
                  onClick={(e) => {
                    e.stopPropagation();
                    setExpandedIndex(isResultExpanded ? null : idx);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.stopPropagation();
                      setExpandedIndex(isResultExpanded ? null : idx);
                    }
                  }}
                  role="button"
                  tabIndex={0}
                  className="p-0.5 rounded hover:bg-input transition-colors cursor-pointer"
                >
                  <ChevronRight 
                    size={10} 
                    className={cn(
                      "text-text-disabled transition-transform",
                      isResultExpanded && "rotate-90"
                    )} 
                  />
                </span>
              </div>

              {/* Expanded Content Preview */}
              {isResultExpanded && (
                <div className="px-2 pb-1.5">
                  <pre className="text-[9px] font-mono text-text-secondary bg-input/30 rounded p-1.5 overflow-x-auto max-h-[100px] overflow-y-auto whitespace-pre-wrap break-words scrollbar-thin scrollbar-track-transparent scrollbar-thumb-border">
                    {result.content}
                  </pre>
                </div>
              )}
            </div>
          );
        })}
      </div>
      
      {/* Gradient fade for long content */}
      {!isExpanded && isLongContent && (
        <div className="absolute bottom-0 left-0 right-0 h-6 bg-gradient-to-t from-editor to-transparent pointer-events-none opacity-50" />
      )}
      
      {/* Expand/Collapse button - matches CodeView */}
      {isLongContent && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            setIsExpanded(!isExpanded);
          }}
          className="absolute bottom-1 right-1 flex items-center gap-1 rounded px-1.5 py-0.5 text-[8px] font-medium bg-sidebar/90 backdrop-blur-sm border border-border text-text-secondary hover:text-text-primary transition-colors"
        >
          {isExpanded ? (
            <>
              <Minimize2 size={8} />
              <span>Less</span>
            </>
          ) : (
            <>
              <Maximize2 size={8} />
              <span>More</span>
            </>
          )}
        </button>
      )}
    </div>
  );
};

// --- 2. Code Block with Diff View ---
interface CodeViewProps {
  data?: any;
  error?: string;
  isStreaming?: boolean;
  fileName?: string; // For syntax highlighting
  originalContent?: string;
  pendingChangeId?: string;
  onAccept?: () => void;
  onReject?: () => void;
}

const CodeView: React.FC<CodeViewProps> = ({
  data,
  error,
  isStreaming,
  fileName
}) => {
  const [isExpanded, setIsExpanded] = useState(false);
  const contentRef = useRef<HTMLPreElement>(null);

  // Auto-scroll to bottom when content is streaming
  useEffect(() => {
    if (isStreaming && contentRef.current) {
      contentRef.current.scrollTop = contentRef.current.scrollHeight;
    }
  }, [data, isStreaming]);

  if (error) {
    return (
      <div className="mt-2 rounded-md bg-red-500/10 border border-red-500/20 p-3">
        <div className="font-mono text-[10px] text-red-400 whitespace-pre-wrap">
          <span className="font-bold">ERROR:</span> {error}
        </div>
      </div>
    );
  }

  if (!data && data !== 0 && data !== false) return null;

  // Basic syntax highlighting for code
  const highlightCode = (code: string, ext: string) => {
    // Keywords for common languages
    const keywords: Record<string, string[]> = {
      ts: ['const', 'let', 'var', 'function', 'async', 'await', 'import', 'export', 'default', 'from', 'interface', 'type', 'class', 'extends', 'implements', 'return', 'if', 'else', 'for', 'while'],
      tsx: ['const', 'let', 'var', 'function', 'async', 'await', 'import', 'export', 'default', 'from', 'interface', 'type', 'class', 'extends', 'implements', 'return', 'if', 'else', 'for', 'while', 'React'],
      js: ['const', 'let', 'var', 'function', 'async', 'await', 'import', 'export', 'default', 'from', 'return', 'if', 'else', 'for', 'while'],
      jsx: ['const', 'let', 'var', 'function', 'async', 'await', 'import', 'export', 'default', 'from', 'return', 'if', 'else', 'for', 'while', 'React'],
      py: ['def', 'class', 'import', 'from', 'return', 'if', 'else', 'elif', 'for', 'while', 'async', 'await'],
      rs: ['fn', 'let', 'mut', 'const', 'use', 'pub', 'impl', 'trait', 'struct', 'enum', 'return', 'if', 'else', 'match'],
    };

    const kw = keywords[ext] || [];
    let highlighted = code;

    // Highlight strings
    highlighted = highlighted.replace(/("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)/g, '<span class="text-emerald-300">$1</span>');

    // Highlight comments
    highlighted = highlighted.replace(/(\/{2,}.*$)/gm, '<span class="text-zinc-500 italic">$1</span>');
    highlighted = highlighted.replace(/(\/\*[\s\S]*?\*\/)/g, '<span class="text-zinc-500 italic">$1</span>');

    // Highlight keywords
    if (kw.length > 0) {
      const kwRegex = new RegExp(`\\b(${kw.join('|')})\\b`, 'g');
      highlighted = highlighted.replace(kwRegex, '<span class="text-purple-400">$1</span>');
    }

    // DON'T highlight numbers - causes false positives in class names

    return highlighted;
  };

  const highlight = (json: string) =>
    json.replace(
      /("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g,
      (match) => {
        let cls = 'text-amber-400';
        if (/^"/.test(match)) {
          cls = /:$/.test(match) ? 'text-sky-300' : 'text-emerald-300';
        } else if (/true|false/.test(match)) {
          cls = 'text-purple-400';
        } else if (/null/.test(match)) {
          cls = 'text-zinc-500';
        }
        return `<span class="${cls}">${match}</span>`;
      }
    );

  const isJson = typeof data !== 'string';
  const content = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  const isLongContent = content.split('\n').length > 8 || content.length > 300;

  return (
    <div className="relative mt-2 overflow-hidden">
      {/* Content directly - no nested box */}
      <pre
        ref={contentRef}
        className={cn(
          "font-mono text-[11px] leading-relaxed p-3 rounded-md bg-transparent overflow-y-auto overflow-x-hidden whitespace-pre-wrap break-words scrollbar-thin scrollbar-track-transparent scrollbar-thumb-transparent hover:scrollbar-thumb-border transition-colors",
          isExpanded ? "max-h-none" : "max-h-[150px]"
          // No border when streaming
        )}
      >
        {isJson ? (
          <code dangerouslySetInnerHTML={{ __html: highlight(content) }} />
        ) : fileName ? (
          // Apply syntax highlighting for code files
          <code dangerouslySetInnerHTML={{ __html: highlightCode(content, fileName.split('.').pop()?.toLowerCase() || '') }} />
        ) : (
          <code className="text-text-secondary">{content}</code>
        )}
      </pre>
      {!isExpanded && isLongContent && (
        <div className="absolute bottom-0 left-0 right-0 h-8 bg-gradient-to-t from-editor to-transparent pointer-events-none opacity-50 rounded-b-md" />
      )}
      {/* Expand button at bottom right */}
      {isLongContent && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            setIsExpanded(!isExpanded);
          }}
          className="absolute bottom-2 right-2 flex items-center gap-1 rounded px-2 py-1 text-[9px] font-medium bg-sidebar/90 backdrop-blur-sm border border-border text-text-secondary hover:text-text-primary transition-colors"
        >
          {isExpanded ? (
            <>
              <Minimize2 size={9} />
              <span>Less</span>
            </>
          ) : (
            <>
              <Maximize2 size={9} />
              <span>More</span>
            </>
          )}
        </button>
      )}
    </div>
  );
};

// --- 3. Tool Item Logic ---
interface ToolItemProps {
  tool: ToolCall;
  isLast: boolean;
  index: number; // For staggered entrance animation
}

const ToolItem: React.FC<ToolItemProps> = React.memo(({ tool, isLast, index }) => {
  // Auto-expand for running tools only
  const isFileModifyTool = ['file_create', 'file_write', 'file_patch'].includes(tool.name);
  const [isOpen, setIsOpen] = useState(
    tool.status === 'executing' ||
    tool.status === 'pending'
  );
  const prevStatusRef = useRef(tool.status);

  const isRunning = tool.status === 'executing' || tool.status === 'pending';
  const isError = tool.status === 'failed' || tool.status === 'rejected';

  useEffect(() => {
    if (prevStatusRef.current !== tool.status) {
      // Close dropdown when tool completes (any tool, including file operations)
      if (['complete', 'failed', 'rejected'].includes(tool.status)) {
        setIsOpen(false);
      } else if (['executing', 'pending'].includes(tool.status)) {
        setIsOpen(true);
      }
      prevStatusRef.current = tool.status;
    }
  }, [tool.status]);

  const filePath = tool.args?.path as string;
  const fileName = filePath ? filePath.split(/[/\\]/).pop() || filePath : '';

  // --- RESULT PARSING & CLEANUP ---
  const { displayData, simpleMessage, isFileList, fileList, isMultiFileResult, multiFileResults, isPendingFileChange, isAuroraSearchResult, auroraSearchResults } = useMemo(() => {
    let raw = null;
    let msg = null;
    let isList = false;
    let listData = [];
    let isMultiFile = false;
    let multiFileData: Array<{ path: string; success: boolean; lines?: number; error?: string; content?: string }> = [];
    let isAuroraSearch = false;
    let auroraResults: Array<{
      filePath: string;
      relativePath: string;
      fileName: string;
      startLine: number;
      endLine: number;
      chunkType: string;
      symbolName: string | null;
      content: string;
      score: number;
      matchType: string;
    }> = [];

    // Tools that should show simple success messages (not raw JSON)
    const simpleMessageTools = [
      'editor_open_file',
      'file_create', 'file_delete', 'file_write', 'file_patch',
      'folder_create', 'folder_delete',
      'workspace_tree',
      'shell_execute', 'shell_spawn', 'shell_kill',
      'grep', 'multi_file_read',
      'todo_write',
      'aurora_search',
    ];

    let isFileChangePending = false;

    // For file_create/file_write/file_patch, always show the content being written
    // Check both parsed args and rawArgs (streaming)
    if (isFileModifyTool) {
      // file_patch uses newContent, others use content
      const contentField = tool.name === 'file_patch' ? tool.args?.newContent : tool.args?.content;
      if (contentField) {
        raw = contentField;
      } else if (tool.rawArgs) {
        // Extract content from streaming rawArgs (incomplete JSON)
        // Try to find "content":" and extract everything after it
        const contentMatch = tool.rawArgs.match(/"content"\s*:\s*"([\s\S]*?)(?:"\s*[,}]|$)/);
        if (contentMatch) {
          // Unescape the JSON string
          try {
            raw = JSON.parse(`"${contentMatch[1]}"`);
          } catch {
            raw = contentMatch[1].replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"');
          }
        } else {
          // Show streaming indicator
          raw = '[Streaming content...]';
        }
      }
    } else if (tool.result) {
      try {
        const parsed = JSON.parse(tool.result);

        // Check for pending file change FIRST
        if (parsed.pending === true && parsed.changeId) {
          isFileChangePending = true;
          msg = parsed.message || 'Pending approval';
        }
        // 1. SHELL EXECUTE - Show command output
        else if (tool.name === 'shell_execute') {
          const cmd = parsed.command || tool.args?.command || 'command';
          if (parsed.success === true) {
            msg = `Executed: ${cmd}`;
            // Show stdout/stderr in code view
            const output = [];
            if (parsed.stdout) output.push(parsed.stdout);
            if (parsed.stderr) output.push(`[stderr] ${parsed.stderr}`);
            if (output.length > 0) {
              raw = output.join('\n');
            }
            if (parsed.exitCode !== 0) {
              msg += ` (exit code: ${parsed.exitCode})`;
            }
          } else {
            msg = `Failed: ${cmd}`;
            if (parsed.error) {
              raw = parsed.error;
            }
          }
        }
        // 2. GREP RESULTS - Show summary only
        else if (tool.name === 'grep' && parsed.success === true) {
          const matchCount = parsed.totalMatches || 0;
          const fileCount = parsed.totalFiles || 0;
          const pattern = parsed.pattern || tool.args?.pattern || 'pattern';

          if (matchCount === 0) {
            msg = `No matches found for "${pattern}"`;
          } else {
            msg = `Found ${matchCount} match${matchCount !== 1 ? 'es' : ''} in ${fileCount} file${fileCount !== 1 ? 's' : ''} for "${pattern}"`;
            // Show the actual matches in code view (truncated)
            if (parsed.matches && parsed.matches.length > 0) {
              raw = parsed.matches.slice(0, 20); // Limit to first 20 matches
            }
          }
        }
        // 2.5. AURORA SEARCH - Semantic search results
        else if (tool.name === 'aurora_search') {
          const query = parsed.query || tool.args?.query || 'query';
          const totalResults = parsed.totalResults || 0;
          const searchMode = parsed.searchMode || 'hybrid';
          
          if (!parsed.success) {
            // Show error/message for failed searches
            msg = parsed.message || parsed.error || 'Search failed';
          } else if (totalResults === 0) {
            msg = `No results found for "${query}"`;
          } else {
            msg = `Found ${totalResults} result${totalResults !== 1 ? 's' : ''} (${searchMode} search)`;
            // Show results in custom component
            if (parsed.results && Array.isArray(parsed.results)) {
              isAuroraSearch = true;
              auroraResults = parsed.results;
            }
          }
        }
        // 3. MULTI FILE READ - Show summary with file list
        else if (tool.name === 'multi_file_read' && parsed.success === true) {
          const filesRead = parsed.filesRead || 0;
          const filesError = parsed.filesError || 0;
          const totalTime = parsed.totalTime || 0;
          const avgTime = parsed.averageTimePerFile || 0;

          msg = `Read ${filesRead} file${filesRead !== 1 ? 's' : ''} in ${totalTime}ms (${avgTime}ms avg)`;
          if (filesError > 0) {
            msg += ` • ${filesError} error${filesError !== 1 ? 's' : ''}`;
          }

          // Show file list with content for clicking
          if (parsed.files && Array.isArray(parsed.files)) {
            isMultiFile = true;
            multiFileData = parsed.files;
          }
        }
        // 4. FILE LIST (workspace_tree with tree)
        else if (parsed.tree && Array.isArray(parsed.tree)) {
          msg = `${parsed.tree.length} items in ${parsed.rootPath?.split(/[/\\]/).pop() || 'workspace'}`;
        }
        // 5. FILE LIST (workspace_list_files)
        else if (parsed.files && Array.isArray(parsed.files)) {
          isList = true;
          listData = parsed.files;
        }
        // 6. FILE READ (Extract 'content' only)
        else if (parsed.content && typeof parsed.content === 'string') {
          raw = parsed.content;
        }
        // 7. Tools that should show simple message
        else if (parsed.success === true && parsed.message && simpleMessageTools.includes(tool.name)) {
          msg = parsed.message;
        }
        // 8. workspace_info - show name and counts
        else if (tool.name === 'workspace_info' && parsed.success === true) {
          msg = parsed.hasWorkspace
            ? `${parsed.name}: ${parsed.totalFiles} files, ${parsed.totalFolders} folders`
            : 'No workspace open';
        }
        // 9. file_exists - show exists status
        else if (tool.name === 'file_exists' && parsed.success === true) {
          msg = parsed.exists ? 'File exists' : 'File does not exist';
        }
        // 10. todo_write - show summary counts only
        else if (tool.name === 'todo_write' && parsed.success === true && parsed.summary) {
          const { total, pending, in_progress, completed } = parsed.summary;
          const parts = [];
          if (completed > 0) parts.push(`${completed} completed`);
          if (in_progress > 0) parts.push(`${in_progress} in progress`);
          if (pending > 0) parts.push(`${pending} pending`);
          msg = `${total} task${total !== 1 ? 's' : ''}: ${parts.join(', ') || 'none'}`;
        }
        // 11. FALLBACK - Only show raw JSON for unknown tools
        else if (!simpleMessageTools.includes(tool.name)) {
          raw = parsed;
        }
        // 12. For known tools without message, just show success
        else if (parsed.success === true) {
          msg = 'Completed successfully';
        }
      } catch {
        raw = tool.result;
      }
    }
    return {
      displayData: raw,
      simpleMessage: msg,
      isFileList: isList,
      fileList: listData,
      isMultiFileResult: isMultiFile,
      multiFileResults: multiFileData,
      isPendingFileChange: isFileChangePending,
      isAuroraSearchResult: isAuroraSearch,
      auroraSearchResults: auroraResults,
    };
  }, [tool.name, tool.args, tool.result, tool.rawArgs, isFileModifyTool]);


  return (
    <motion.div
      initial={{ opacity: 0, x: 8 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{
        duration: 0.25,
        delay: index * 0.04, // 40ms stagger per card
        ease: [0.16, 1, 0.3, 1] // Premium spring ease
      }}
      className="group relative flex gap-3"
    >
      {/* Left Timeline Track */}
      <div className="flex flex-col items-center w-5 flex-shrink-0 relative">
        {/* Connection Line */}
        <div
          className={cn(
            "absolute top-0 bottom-0 w-px transition-colors duration-300",
            isLast ? "bg-transparent h-4" : "bg-border/30 group-hover:bg-border/50"
          )}
        />

        {/* Status Dot/Icon */}
        <div
          className={cn(
            "relative z-10 flex h-5 w-5 items-center justify-center rounded-full ring-2 shadow-sm mt-3 backdrop-blur-md transition-all duration-300",
            isRunning
              ? "bg-sidebar ring-blue-500/50 text-blue-400 scale-110"
              : isError
                ? "bg-sidebar ring-red-500/50 text-red-400"
                : "bg-sidebar ring-border text-success group-hover:ring-success/30"
          )}
        >
          {isRunning ? <Loader2 size={10} className="animate-spin" /> :
            isError ? <X size={10} /> :
              <Check size={10} />}
        </div>
      </div>

      {/* Right Content */}
      <div className="min-w-0 flex-1 pb-4 pt-1">
        <div
          className={cn(
            "overflow-hidden rounded-xl border transition-all duration-300",
            "bg-[var(--aurora-chat-surface)] shadow-premium glass-light",
            isOpen
              ? "border-[var(--aurora-common-border)] ring-1 ring-white/5 shadow-premium-lg glass-medium"
              : "border-transparent hover:border-[var(--aurora-common-border)]/50"
            // NO glow effect for running tools - user doesn't want background colors
          )}
        >
          {/* Header */}
          <button
            onClick={() => setIsOpen(!isOpen)}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left"
          >
            {isRunning ? (
              <ShimmerText className="text-xs font-semibold tracking-tight text-blue-300">
                {tool.name}
              </ShimmerText>
            ) : (
              <span className="text-xs font-semibold tracking-tight text-text-secondary">
                {tool.name}
              </span>
            )}

            {/* Filename in Header (show only filename, not full path with icon) */}
            {fileName && (() => {
              // Detect if this is a folder operation
              const isFolderOperation = ['folder_create', 'folder_delete', 'workspace_tree'].includes(tool.name);

              return (
                <span
                  onClick={async (e) => {
                    e.stopPropagation();
                    // Open file in editor when clicked (same pattern as MultiFileResultsView)
                    if (!isFolderOperation && filePath) {
                      try {
                        const { useEditorStore } = await import('../../store/useEditorStore');
                        const { resolvePath } = await import('../../tools/utils/path-resolver');
                        const { readFileContent } = await import('../../lib/tauri');

                        // Resolve full path
                        const fullPath = resolvePath(filePath);

                        // Read file content
                        const content = await readFileContent(fullPath);

                        // Detect language from extension
                        const ext = fileName.split('.').pop()?.toLowerCase() || '';
                        const langMap: Record<string, string> = {
                          'ts': 'typescript', 'tsx': 'typescript',
                          'js': 'javascript', 'jsx': 'javascript',
                          'json': 'json', 'css': 'css', 'scss': 'scss',
                          'html': 'html', 'md': 'markdown',
                          'rs': 'rust', 'toml': 'toml',
                          'yaml': 'yaml', 'yml': 'yaml',
                          'py': 'python', 'go': 'go',
                        };
                        const language = langMap[ext] || 'plaintext';

                        // Open in editor
                        useEditorStore.getState().openFile(fullPath, fileName, content, language);
                      } catch (error) {
                        console.error('Failed to open file:', error);
                      }
                    }
                  }}
                  role={isFolderOperation ? undefined : "button"}
                  tabIndex={isFolderOperation ? undefined : 0}
                  className={cn(
                    "flex min-w-0 items-center gap-1.5 overflow-hidden text-[11px] rounded-md px-2 py-0.5 transition-colors",
                    isFolderOperation
                      ? "text-text-primary cursor-default"
                      : "text-text-primary hover:bg-input/50 cursor-pointer"
                  )}
                >
                  <ArrowRight size={10} className="text-text-disabled flex-shrink-0" />
                  {isFolderOperation ? (
                    <Folder size={14} className="text-blue-400/80 fill-blue-400/10 flex-shrink-0" />
                  ) : (
                    <img
                      src={getIconUrl(getIconName(fileName, false))}
                      alt=""
                      className="w-3.5 h-3.5 flex-shrink-0"
                    />
                  )}
                  <span className="truncate font-medium">{fileName}</span>
                </span>
              );
            })()}

            <div className="ml-auto flex items-center gap-3">
              <span className={cn(
                "text-[9px] uppercase tracking-wider font-semibold",
                isRunning ? "text-blue-400 animate-pulse" :
                  isError ? "text-red-400" : "text-emerald-500/50"
              )}>
                {/* Show better status for file operations */}
                {isFileModifyTool && isRunning
                  ? (tool.name === 'file_create' ? 'Creating...' :
                    tool.name === 'file_patch' ? 'Patching...' : 'Writing...')
                  : tool.status}
              </span>
              <ChevronRight
                size={14}
                className={cn("text-text-disabled transition-transform duration-200", isOpen && "rotate-90")}
              />
            </div>
          </button>

          {/* Body */}
          <div
            className={cn(
              "grid transition-all duration-300 ease-in-out",
              isOpen ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"
            )}
          >
            <div className="overflow-hidden">
              <div className="border-t border-border bg-input/30 px-3 py-3 space-y-3">

                {/* Arguments (Cleaned) - Hide raw/content/newContent for file operations */}
                {Object.keys(tool.args || {}).filter(k =>
                  !['content', 'path', 'raw', 'newContent'].includes(k)
                ).length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {Object.entries(tool.args || {})
                        .filter(([key]) => !['content', 'path', 'raw', 'newContent'].includes(key))
                        .map(([key, value]) => (
                          <div
                            key={key}
                            className="flex items-center gap-1.5 rounded bg-input px-2 py-1 text-[10px] border border-border hover:border-border/80 transition-colors"
                          >
                            <span className="text-text-secondary">{key}</span>
                            <span className="text-text-primary font-mono">
                              {String(value).length > 40 ? `${String(value).slice(0, 40)}…` : String(value)}
                            </span>
                          </div>
                        ))}
                    </div>
                  )}

                {/* 1. File Explorer View */}
                {isFileList && fileList.length > 0 && (
                  <FileExplorerView files={fileList} />
                )}

                {/* 2. Multi-File Read Results */}
                {isMultiFileResult && multiFileResults.length > 0 && (
                  <MultiFileResultsView files={multiFileResults} />
                )}

                {/* 2.5. Aurora Search Results */}
                {isAuroraSearchResult && auroraSearchResults.length > 0 && (
                  <AuroraSearchResultsView results={auroraSearchResults} />
                )}

                {/* 3. Simple Success Banner */}
                {simpleMessage && !tool.error && !isFileList && !isMultiFileResult && !isAuroraSearchResult && !isPendingFileChange && (
                  <div className="flex items-center gap-2 rounded border border-emerald-500/20 bg-emerald-500/5 px-3 py-2">
                    <Check size={12} className="text-emerald-400" />
                    <span className="font-mono text-[11px] text-emerald-100/80">
                      {simpleMessage}
                    </span>
                  </div>
                )}

                {/* 4. Code View (Now shows pure content for read_file and handles file modification approvals) */}
                {(displayData || tool.error) && !isMultiFileResult && (
                  <CodeView
                    data={displayData}
                    error={tool.error}
                    isStreaming={isFileModifyTool && isRunning}
                    fileName={fileName}
                  />
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </motion.div>
  );
}, (prev, next) => {
  return (
    prev.tool.id === next.tool.id &&
    prev.tool.status === next.tool.status &&
    prev.tool.result === next.tool.result &&
    prev.tool.rawArgs === next.tool.rawArgs &&
    prev.tool.args?.content === next.tool.args?.content &&
    prev.isLast === next.isLast &&
    prev.index === next.index // Compare index too
  );
});

export const ToolTimeline: React.FC<{ tools: ToolCall[] }> = ({ tools }) => {
  if (!tools || tools.length === 0) return null;
  return (
    <div className="space-y-0 relative w-full pl-1">
      {tools.map((tool, idx) => (
        <ToolItem key={tool.id} tool={tool} isLast={idx === tools.length - 1} index={idx} />
      ))}
    </div>
  );
};