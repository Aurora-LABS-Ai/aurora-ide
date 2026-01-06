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
import { getToolDisplayName } from '../../services/mcp-tools';

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
      if (!a?.name || !b?.name) return 0;
      if (a.type === b.type) return a.name.localeCompare(b.name);
      return a.type === 'directory' ? -1 : 1;
    });
  }, [files]);

  const displayedFiles = isExpanded ? sortedFiles : sortedFiles.slice(0, 6);
  const remainingCount = sortedFiles.length - 6;

  return (
    <div className="mt-1 pl-1 border-l border-border/40">
      <div className="flex items-center gap-2 px-2 py-1">
        <LayoutGrid size={10} className="text-text-secondary" />
        <span className="text-[10px] text-text-secondary uppercase tracking-wider">
          Directory Listing ({files.length})
        </span>
      </div>

      <div className="pl-2 mt-1 grid gap-0.5">
        {displayedFiles.map((file, idx) => (
          <div key={idx} className="flex items-center gap-2 rounded px-2 py-1 hover:bg-white/5 transition-colors">
            {file.type === 'directory' ? (
              <Folder size={12} className="text-blue-400/80 fill-blue-400/10" />
            ) : (
              <File size={12} className="text-text-secondary" />
            )}
            <span className={cn(
              "truncate text-[10px]",
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
          className="ml-2 mt-1 text-[10px] text-text-disabled hover:text-text-primary transition-colors flex items-center gap-1"
        >
          <span>+{remainingCount} more...</span>
        </button>
      )}

      {isExpanded && files.length > 6 && (
        <button
          onClick={(e) => { e.stopPropagation(); setIsExpanded(false); }}
          className="ml-2 mt-1 text-[10px] text-text-disabled hover:text-text-primary transition-colors"
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
      const fullPath = resolvePath(file.path);
      const filename = fullPath.split(/[/\\]/).pop() || file.path;
      const ext = filename.split('.').pop()?.toLowerCase() || '';
      const langMap: Record<string, string> = {
        'ts': 'typescript', 'tsx': 'typescript',
        'js': 'javascript', 'jsx': 'javascript',
        'json': 'json', 'css': 'css', 'scss': 'scss',
        'html': 'html', 'md': 'markdown',
        'rs': 'rust',
        'py': 'python', 'go': 'go',
      };
      const language = langMap[ext] || 'plaintext';
      useEditorStore.getState().openFile(fullPath, filename, file.content, language);
    } catch (error) {
      console.error('Failed to open file:', error);
    }
  };

  const getFileName = (path: string) => path.split(/[/\\]/).pop() || path;

  return (
    <div className="flex flex-col gap-0.5 mt-1">
      {files.map((file, idx) => {
        const fileName = getFileName(file.path);
        return (
          <button
            key={idx}
            onClick={() => handleFileClick(file)}
            disabled={!file.success}
            className={cn(
              "w-full flex items-center justify-between gap-2 rounded px-2 py-1 text-left group transition-colors",
              file.success
                ? "hover:bg-emerald-500/5 cursor-pointer"
                : "opacity-60 cursor-not-allowed"
            )}
          >
            <div className="flex items-center gap-2 min-w-0 overflow-hidden">
              {file.success ? (
                <Check size={10} className="text-emerald-400 shrink-0" />
              ) : (
                <X size={10} className="text-red-400 shrink-0" />
              )}
              <img
                src={getIconUrl(getIconName(fileName, false))}
                alt=""
                className="w-3 h-3 flex-shrink-0"
              />
              <span className="truncate text-[10px] text-text-secondary group-hover:text-text-primary transition-colors">
                {fileName}
              </span>
            </div>
          </button>
        );
      })}
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
      const fullPath = resolvePath(result.filePath);
      const content = await readFileContent(fullPath);
      const ext = result.fileName.split('.').pop()?.toLowerCase() || '';
      const langMap: Record<string, string> = {
        'ts': 'typescript', 'tsx': 'typescript',
        'js': 'javascript', 'jsx': 'javascript',
        'json': 'json', 'css': 'css', 'scss': 'scss',
        'html': 'html', 'md': 'markdown',
        'rs': 'rust',
        'py': 'python', 'go': 'go',
      };
      const language = langMap[ext] || 'plaintext';
      useEditorStore.getState().openFile(fullPath, result.fileName, content, language);
    } catch (error) {
      console.error('Failed to open file:', error);
    }
  };

  const isLongContent = results.length > 3;

  return (
    <div className="mt-1">
      <div
        className={cn(
          "grid gap-0.5 overflow-hidden transition-all",
          isExpanded ? "max-h-none" : "max-h-[120px]"
        )}
      >
        {results.map((result, idx) => {
          const isResultExpanded = expandedIndex === idx;
          const scorePercent = Math.round(result.score * 100);

          return (
            <div key={idx} className="group border-b border-white/5 last:border-0">
              <div
                onClick={() => handleResultClick(result)}
                className="w-full flex items-center gap-2 px-2 py-1 hover:bg-white/5 cursor-pointer transition-colors"
              >
                <img
                  src={getIconUrl(getIconName(result.fileName, false))}
                  alt=""
                  className="w-3 h-3 flex-shrink-0 opacity-80"
                />

                <div className="flex-1 min-w-0 flex items-center gap-1.5">
                  <span className="text-[10px] font-medium text-text-primary truncate">
                    {result.fileName}
                  </span>
                  <span className="text-[9px] text-text-disabled font-mono flex-shrink-0">
                    :{result.startLine}
                  </span>
                </div>

                <div className="flex items-center gap-1 flex-shrink-0">
                  <div className="w-4 h-0.5 bg-white/10 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-primary/70 rounded-full"
                      style={{ width: `${scorePercent}%` }}
                    />
                  </div>
                </div>

                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setExpandedIndex(isResultExpanded ? null : idx);
                  }}
                  className="p-0.5 text-text-disabled hover:text-text-primary"
                >
                  <ChevronRight
                    size={10}
                    className={cn("transition-transform", isResultExpanded && "rotate-90")}
                  />
                </button>
              </div>

              {isResultExpanded && (
                <div className="px-2 pb-1.5">
                  <pre className="text-[9px] font-mono text-text-secondary bg-black/20 rounded p-1.5 overflow-x-auto whitespace-pre-wrap break-words">
                    {result.content}
                  </pre>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {isLongContent && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            setIsExpanded(!isExpanded);
          }}
          className="mt-1 w-full text-center text-[9px] text-text-disabled hover:text-text-primary py-0.5"
        >
          {isExpanded ? "Show Less" : `Show ${results.length - 3} More`}
        </button>
      )}
    </div>
  );
};

// --- 2. Code Block View ---
interface CodeViewProps {
  data?: any;
  error?: string;
  isStreaming?: boolean;
  fileName?: string;
}

/**
 * Unescape JSON string escapes to show actual content
 * Converts \n → newline, \" → ", \\ → \, etc.
 */
const unescapeContent = (str: string): string => {
  if (!str) return str;
  try {
    // Try to parse as JSON string to unescape
    // Wrap in quotes if not already a valid JSON string
    if (!str.startsWith('"')) {
      return str
        .replace(/\\n/g, '\n')
        .replace(/\\r/g, '\r')
        .replace(/\\t/g, '\t')
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, '\\');
    }
    return JSON.parse(str);
  } catch {
    // Manual unescape if JSON parse fails
    return str
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '\r')
      .replace(/\\t/g, '\t')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\');
  }
};

const CodeView: React.FC<CodeViewProps> = ({
  data,
  error,
  isStreaming,
  fileName
}) => {
  const contentRef = useRef<HTMLDivElement>(null);
  const [isExpanded, setIsExpanded] = useState(false);

  useEffect(() => {
    if (isStreaming && contentRef.current) {
      contentRef.current.scrollTop = contentRef.current.scrollHeight;
    }
  }, [data, isStreaming]);

  if (error) {
    return (
      <div className="mt-1 rounded bg-red-500/10 p-2 border border-red-500/20">
        <div className="font-mono text-[10px] text-red-300 whitespace-pre-wrap">
          <span className="font-bold">Error:</span> {error}
        </div>
      </div>
    );
  }

  if (!data && data !== 0 && data !== false) return null;

  const rawContent = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  
  // Unescape the content to show actual newlines, quotes, etc.
  const content = unescapeContent(rawContent);
  const lines = content.split('\n');
  const isLongContent = lines.length > 8;
  const displayLines = isExpanded ? lines : lines.slice(0, 8);
  
  // Get file extension for styling
  const ext = fileName?.split('.').pop()?.toLowerCase() || '';
  const isCode = ['ts', 'tsx', 'js', 'jsx', 'py', 'rs', 'go', 'css', 'scss', 'html', 'json', 'md'].includes(ext);

  return (
    <div className="relative mt-1 group">
      {/* File header bar */}
      {fileName && (
        <div className="flex items-center gap-2 px-2 py-1 bg-black/30 rounded-t border-b border-white/5">
          <img
            src={getIconUrl(getIconName(fileName, false))}
            alt=""
            className="w-3 h-3 flex-shrink-0 opacity-70"
          />
          <span className="text-[9px] text-text-secondary font-mono">{fileName}</span>
          <span className="text-[8px] text-text-disabled ml-auto">{lines.length} lines</span>
        </div>
      )}
      
      <div 
        ref={contentRef}
        style={{ maxHeight: isExpanded ? '300px' : '160px' }}
        className={cn(
          "font-mono text-[10px] leading-[1.6] bg-black/20 overflow-y-auto overflow-x-auto scrollbar-thin scrollbar-thumb-white/10 hover:scrollbar-thumb-white/20 scrollbar-track-transparent",
          fileName ? "rounded-b" : "rounded"
        )}
      >
        <table className="w-full border-collapse">
          <tbody>
            {displayLines.map((line, idx) => (
              <tr key={idx} className="hover:bg-white/5">
                {/* Line number */}
                <td className="text-[9px] text-text-disabled/50 text-right pr-3 pl-2 py-0 select-none w-8 align-top border-r border-white/5">
                  {idx + 1}
                </td>
                {/* Code content */}
                <td className="pl-3 pr-2 py-0">
                  <pre className="whitespace-pre-wrap break-all">
                    <code className={cn(
                      "text-text-secondary",
                      isCode && "text-text-primary"
                    )}>
                      {line || ' '}
                    </code>
                  </pre>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      
      {/* Expand/Collapse button */}
      {isLongContent && (
        <button
          onClick={(e) => { e.stopPropagation(); setIsExpanded(!isExpanded); }}
          className="w-full text-center text-[9px] text-text-disabled hover:text-text-primary py-1 bg-black/20 rounded-b border-t border-white/5"
        >
          {isExpanded ? 'Show Less' : `Show ${lines.length - 8} More Lines`}
        </button>
      )}
    </div>
  );
};

// --- 3. Tool Item Logic ---
interface ToolItemProps {
  tool: ToolCall;
  isLast: boolean;
  index: number;
}

const ToolItem: React.FC<ToolItemProps> = React.memo(({ tool, isLast }) => {
  const isFileModifyTool = ['file_create', 'file_write', 'file_patch', 'search_replace'].includes(tool.name);
  const [isOpen, setIsOpen] = useState(false);

  // Auto-expand errors
  useEffect(() => {
    if (tool.status === 'failed' || tool.status === 'rejected') {
      setIsOpen(true);
    }
  }, [tool.status]);

  // Derived status logic - simple: show running spinner while pending/executing, red X only for actual failures
  const isRunning = tool.status === 'executing' || tool.status === 'pending';
  const isError = tool.status === 'failed' || tool.status === 'rejected';

  const filePath = tool.args?.path as string;
  const fileName = filePath ? filePath.split(/[/\\]/).pop() || filePath : '';

  // Handle file click to open in editor
  const handleFileClick = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!filePath) return;

    try {
      const { useEditorStore } = await import('../../store/useEditorStore');
      const { resolvePath } = await import('../../tools/utils/path-resolver');
      const { readFileContent } = await import('../../lib/tauri');

      const fullPath = resolvePath(filePath);
      // Read file content if not a file modify tool (already have content from tool args)

      // safely read content
      let fileContent = '';
      try {
        fileContent = await readFileContent(fullPath);
      } catch (e) { console.warn('Could not read file content', e); }

      const ext = fileName.split('.').pop()?.toLowerCase() || '';
      const langMap: Record<string, string> = {
        'ts': 'typescript', 'tsx': 'typescript',
        'js': 'javascript', 'jsx': 'javascript',
        'json': 'json', 'css': 'css', 'scss': 'scss',
        'html': 'html', 'md': 'markdown',
        'rs': 'rust',
        'py': 'python', 'go': 'go',
      };
      const language = langMap[ext] || 'plaintext';

      useEditorStore.getState().openFile(fullPath, fileName, fileContent, language);
    } catch (error) {
      console.error('Failed to open file:', error);
    }
  };

  // Data processing hook
  const { displayData, simpleMessage, isFileList, fileList, isMultiFileResult, multiFileResults, isAuroraSearchResult, auroraSearchResults, searchReplaceData, linesAdded, linesRemoved } = useMemo(() => {
    let raw = null;
    let msg = null;
    let isList = false;
    let listData = [];
    let isMultiFile = false;
    let multiFileData = [];
    let isAuroraSearch = false;
    let auroraResults = [];
    let linesAddedCount: number | null = null;
    let linesRemovedCount: number | null = null;
    let isFileChangePending = false;

    // file_create, file_write are FILE MODIFY tools so they should show parsed content
    let searchReplaceData: { oldString?: string; newString?: string } | null = null;

    if (tool.name === 'search_replace') {
      // Special handling for search_replace - show old_string and new_string
      const oldStr = tool.args?.old_string as string | undefined;
      const newStr = tool.args?.new_string as string | undefined;
      if (oldStr || newStr) {
        searchReplaceData = { oldString: oldStr, newString: newStr };
      }
    } else if (isFileModifyTool || tool.name === 'file_read') { // Added file_read here to show content
      const contentField = tool.name === 'file_patch' ? tool.args?.newContent : tool.args?.content;
      if (contentField) raw = contentField;
      else if (tool.rawArgs) {
        const m = tool.rawArgs.match(/"content"\s*:\s*"([\s\S]*?)(?:"\s*[,}]|$)/);
        if (m) raw = m[1];
        // else raw = '...'; // Don't show ... for clean look
      }

      // For file_read, try to get from result
      if (tool.name === 'file_read' && tool.result) {
        try {
          const parsed = JSON.parse(tool.result);
          if (parsed.content) raw = parsed.content;
        } catch { raw = tool.result; }
      }
    }
    
    if (tool.result) {
      try {
        const parsed = JSON.parse(tool.result);
        if (tool.name === 'search_replace') {
          if (parsed.linesAdded) linesAddedCount = parsed.linesAdded;
          if (parsed.linesRemoved) linesRemovedCount = parsed.linesRemoved;
        }
        if (parsed.pending) {
          isFileChangePending = true;
          // Don't show "Pending approval" - tools auto-approve
        } else if (tool.name === 'shell_execute') {
          const cmd = parsed.command || tool.args?.command || 'cmd';
          if (parsed.success) {
            msg = `Ran: ${cmd}`;
            const out = [];
            if (parsed.stdout) out.push(parsed.stdout);
            if (parsed.stderr) out.push(parsed.stderr);
            if (out.length) raw = out.join('\n');
          } else {
            msg = `Failed: ${cmd}`;
            if (parsed.error) raw = parsed.error;
          }
        } else if (tool.name === 'aurora_search') {
          const count = parsed.totalResults || 0;
          if (!parsed.success) msg = "Search failed";
          else if (count === 0) msg = "No results";
          else {
            msg = `Found ${count} results`;
            if (parsed.results) { isAuroraSearch = true; auroraResults = parsed.results; }
          }
        } else if (tool.name === 'multi_file_read' && parsed.success) {
          msg = `Read ${parsed.filesRead || 0} files`;
          if (parsed.files) { isMultiFile = true; multiFileData = parsed.files; }
        } else if (parsed.files) {
          if (tool.name.includes('workspace')) {
            isList = true; listData = parsed.files;
          }
        } else if (parsed.content) {
          raw = parsed.content;
        } else if (parsed.message) {
          // Clean up messages - remove long paths, keep it short
          const rawMsg = parsed.message as string;
          if (tool.name === 'search_replace') {
            const match = rawMsg.match(/Replaced (\d+) occurrence/);
            msg = match ? `Replaced ${match[1]}` : 'Done';
          } else if (rawMsg.includes(':\\') || rawMsg.includes(':/') || rawMsg.length > 50) {
            // Message contains path or is too long - simplify it
            if (rawMsg.toLowerCase().includes('created')) msg = 'Created';
            else if (rawMsg.toLowerCase().includes('deleted')) msg = 'Deleted';
            else if (rawMsg.toLowerCase().includes('written') || rawMsg.toLowerCase().includes('wrote')) msg = 'Written';
            else if (rawMsg.toLowerCase().includes('updated')) msg = 'Updated';
            else msg = 'Done';
          } else {
            msg = rawMsg;
          }
        } else if (parsed.success) {
          msg = "Done";
        }
      } catch { raw = tool.result; }
    }

    return { displayData: raw, simpleMessage: msg, isFileList: isList, fileList: listData, isMultiFileResult: isMultiFile, multiFileResults: multiFileData, isPendingFileChange: isFileChangePending, isAuroraSearchResult: isAuroraSearch, auroraSearchResults: auroraResults, linesAdded: linesAddedCount, linesRemoved: linesRemovedCount, searchReplaceData };
  }, [tool]);

  return (
    <div className="group relative flex gap-3 pb-1">
      {/* Timeline Track */}
      <div className="flex flex-col items-center w-4 flex-shrink-0 relative">
        <div className={cn(
          "absolute top-0 bottom-0 w-px transition-colors duration-300",
          isLast ? "bg-transparent" : "bg-border/20 group-hover:bg-border/40"
        )} />

        <div className={cn(
          "relative z-10 flex h-3 w-3 items-center justify-center rounded-full mt-2.5 transition-all text-[8px]",
          isError ? "bg-red-500/20 text-red-400 ring-2 ring-red-500/10" :
            isRunning ? "bg-blue-500/20 text-blue-400 ring-2 ring-blue-500/10" :
              "bg-emerald-500/20 text-emerald-400 ring-2 ring-emerald-500/10"
        )}>
          {isError ? <X size={8} /> :
            isRunning ? <Loader2 size={8} className="animate-spin" /> :
              <Check size={8} />}
        </div>
      </div>

      {/* Content */}
      <div className="min-w-0 flex-1 pt-1.5 pb-2">
        <div className="flex items-start gap-2">
          <button
            onClick={() => setIsOpen(!isOpen)}
            className="flex-1 text-left flex items-baseline gap-2 group/header outline-none"
          >
            {isError ? (
              <span className="text-[11px] font-medium tracking-tight text-red-400">
                {getToolDisplayName(tool.name)}
              </span>
            ) : isRunning ? (
              <ShimmerText className="text-[11px] font-medium tracking-tight text-blue-400">
                {getToolDisplayName(tool.name)}
              </ShimmerText>
            ) : (
              <span className="text-[11px] font-medium tracking-tight text-text-primary">
                {getToolDisplayName(tool.name)}
              </span>
            )}

            {/* Compact Filename Pill if applicable */}
            {fileName && (
              <span
                onClick={handleFileClick}
                role="button"
                tabIndex={0}
                className="flex items-center gap-1.5 text-[10px] text-text-secondary px-1.5 py-0.5 rounded-sm bg-white/5 border border-white/5 hover:bg-white/10 hover:border-white/10 transition-all cursor-pointer"
              >
                <img
                  src={getIconUrl(getIconName(fileName, false))}
                  alt=""
                  className="w-3 h-3 flex-shrink-0"
                />
                <span className="opacity-80 hover:opacity-100 underline decoration-transparent hover:decoration-white/20 underline-offset-2">{fileName}</span>
              </span>
            )}

            {/* Status Message + Line Diff Stats */}
            <span className="text-[10px] text-text-disabled truncate opacity-70 group-hover/header:opacity-100 transition-opacity flex items-center gap-1.5">
              {/* Line diff stats for search_replace */}
              {(linesAdded !== null || linesRemoved !== null) && (
                <span className="flex items-center gap-1 font-mono">
                  {linesAdded !== null && linesAdded > 0 && (
                    <span className="text-emerald-400">+{linesAdded}</span>
                  )}
                  {linesRemoved !== null && linesRemoved > 0 && (
                    <span className="text-red-400">-{linesRemoved}</span>
                  )}
                </span>
              )}
              {/* Regular status message */}
              {!(linesAdded || linesRemoved) && (simpleMessage || (isError ? 'Failed' : (isRunning ? 'Running...' : '')))}
            </span>
          </button>
        </div>

        {/* EXPANDED CONTENT - No Box, just indented */}
        <motion.div
          initial={false}
          animate={{ height: isOpen ? 'auto' : 0, opacity: isOpen ? 1 : 0 }}
          className="overflow-hidden"
        >
          <div className="pt-2 pl-1 border-l border-white/5 ml-1">
            {/* Arguments List - Minimal */}
            {Object.keys(tool.args || {}).filter(k => !['content', 'path', 'raw', 'newContent', 'todos'].includes(k)).length > 0 && (
              <div className="flex flex-wrap gap-1 mb-2">
                {Object.entries(tool.args || {})
                  .filter(([k]) => !['content', 'path', 'raw', 'newContent', 'todos'].includes(k))
                  .map(([k, v]) => {
                    // Format value properly - handle objects/arrays
                    let displayValue: string;
                    if (v === null || v === undefined) {
                      displayValue = 'null';
                    } else if (typeof v === 'object') {
                      displayValue = Array.isArray(v) ? `[${v.length} items]` : '{...}';
                    } else {
                      displayValue = String(v).substring(0, 30);
                    }
                    return (
                      <span key={k} className="text-[9px] px-1.5 py-0.5 rounded bg-white/5 text-text-secondary border border-white/5">
                        <span className="opacity-60">{k}:</span> {displayValue}
                      </span>
                    );
                  })
                }
              </div>
            )}
            
            {/* Todo List Display - Special handling for todo_write */}
            {tool.name === 'todo_write' && tool.args?.todos && Array.isArray(tool.args.todos) && (
              <div className="mb-2 space-y-1">
                {(tool.args.todos as Array<{id?: string; content?: string; status?: string}>).map((todo, idx) => (
                  <div key={todo.id || idx} className="flex items-center gap-2 text-[10px] px-2 py-1 rounded bg-white/5 border border-white/5">
                    <span className={cn(
                      "w-1.5 h-1.5 rounded-full flex-shrink-0",
                      todo.status === 'completed' ? "bg-emerald-400" :
                      todo.status === 'in_progress' ? "bg-blue-400" :
                      todo.status === 'cancelled' ? "bg-red-400" :
                      "bg-zinc-400"
                    )} />
                    <span className="text-text-secondary truncate">{todo.content || 'Untitled task'}</span>
                    {todo.status && (
                      <span className={cn(
                        "ml-auto text-[9px] px-1 py-0.5 rounded flex-shrink-0",
                        todo.status === 'completed' ? "bg-emerald-500/20 text-emerald-400" :
                        todo.status === 'in_progress' ? "bg-blue-500/20 text-blue-400" :
                        todo.status === 'cancelled' ? "bg-red-500/20 text-red-400" :
                        "bg-zinc-500/20 text-zinc-400"
                      )}>
                        {todo.status}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}

            {isFileList && fileList.length > 0 && <FileExplorerView files={fileList} />}
            {isMultiFileResult && multiFileResults.length > 0 && <MultiFileResultsView files={multiFileResults} />}
            {isAuroraSearchResult && auroraSearchResults.length > 0 && <AuroraSearchResultsView results={auroraSearchResults} />}

            {/* Search/Replace Diff View */}
            {searchReplaceData && (searchReplaceData.oldString || searchReplaceData.newString) && (
              <div className="space-y-2">
                {/* Old String (what was replaced) */}
                {searchReplaceData.oldString && (
                  <div>
                    <div className="flex items-center gap-2 px-2 py-1 bg-red-500/10 rounded-t border-b border-red-500/20">
                      <span className="text-[9px] font-medium text-red-400">OLD</span>
                      <span className="text-[8px] text-red-400/60">removed</span>
                    </div>
                    <CodeView
                      data={searchReplaceData.oldString}
                      fileName={fileName}
                    />
                  </div>
                )}
                {/* New String (replacement) */}
                {searchReplaceData.newString && (
                  <div>
                    <div className="flex items-center gap-2 px-2 py-1 bg-emerald-500/10 rounded-t border-b border-emerald-500/20">
                      <span className="text-[9px] font-medium text-emerald-400">NEW</span>
                      <span className="text-[8px] text-emerald-400/60">added</span>
                    </div>
                    <CodeView
                      data={searchReplaceData.newString}
                      fileName={fileName}
                    />
                  </div>
                )}
              </div>
            )}

            {(displayData || tool.error) && !isMultiFileResult && !searchReplaceData && (
              <CodeView
                data={displayData}
                error={tool.error}
                isStreaming={isRunning}
                fileName={fileName}
              />
            )}
          </div>
        </motion.div>
      </div>
    </div>
  );
});

export const ToolTimeline: React.FC<{ tools: ToolCall[] }> = ({ tools }) => {
  if (!tools || tools.length === 0) return null;
  return (
    <div className="w-full mt-2 pl-2">
      {tools.map((tool, idx) => (
        <ToolItem
          key={tool.id}
          tool={tool}
          isLast={idx === tools.length - 1}
          index={idx}
        />
      ))}
    </div>
  );
};