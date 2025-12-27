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
  LayoutGrid
} from 'lucide-react';
import clsx from 'clsx';
import { twMerge } from 'tailwind-merge';
import type { ToolCall } from '../../types';

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
    <div className="mt-2 rounded-lg border border-white/10 bg-[#151515] overflow-hidden">
      <div className="flex items-center justify-between border-b border-white/5 bg-white/[0.02] px-3 py-2">
        <div className="flex items-center gap-2">
          <LayoutGrid size={12} className="text-zinc-400" />
          <span className="font-mono text-[10px] font-medium text-zinc-400 uppercase tracking-wider">
            Directory Listing
          </span>
        </div>
        <span className="text-[10px] text-zinc-600 font-mono">
          {files.length} items
        </span>
      </div>

      <div className="p-2 grid grid-cols-1 sm:grid-cols-2 gap-2">
        {displayedFiles.map((file, idx) => (
          <div key={idx} className="flex items-center gap-2 rounded-md bg-white/[0.03] px-2 py-1.5 border border-white/5">
            {file.type === 'directory' ? (
              <Folder size={14} className="text-blue-400/80 fill-blue-400/10" />
            ) : (
              <File size={14} className="text-zinc-400" />
            )}
            <span className={cn(
              "truncate font-mono text-[11px]",
              file.type === 'directory' ? "text-zinc-200 font-medium" : "text-zinc-400"
            )}>
              {file.name}
            </span>
          </div>
        ))}
      </div>

      {!isExpanded && remainingCount > 0 && (
        <button
          onClick={(e) => { e.stopPropagation(); setIsExpanded(true); }}
          className="w-full border-t border-white/5 bg-white/[0.01] py-1.5 text-center font-mono text-[10px] text-zinc-500 hover:text-zinc-300 transition-colors"
        >
          + {remainingCount} more items...
        </button>
      )}

      {isExpanded && files.length > 6 && (
        <button
          onClick={(e) => { e.stopPropagation(); setIsExpanded(false); }}
          className="w-full border-t border-white/5 bg-white/[0.01] py-1.5 text-center font-mono text-[10px] text-zinc-500 hover:text-zinc-300 transition-colors"
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
    <div className="mt-2 rounded-lg border border-white/10 bg-[#151515] overflow-hidden">
      <div className="flex items-center justify-between border-b border-white/5 bg-white/[0.02] px-3 py-2">
        <div className="flex items-center gap-2">
          <FileCode size={12} className="text-zinc-400" />
          <span className="font-mono text-[10px] font-medium text-zinc-400 uppercase tracking-wider">
            Files Read
          </span>
        </div>
        <span className="text-[10px] text-zinc-600 font-mono">
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
              <span className="truncate font-mono text-[11px] text-zinc-300 text-left">
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

// --- 2. Code Block ---
interface CodeViewProps {
  data?: any;
  error?: string;
  title?: string;
}

const CodeView: React.FC<CodeViewProps> = ({ data, error, title }) => {
  const [isExpanded, setIsExpanded] = useState(false);

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
    <div className="group/code mt-3 overflow-hidden rounded-md border border-white/5 bg-[#101010]">
      <div className="flex items-center justify-between border-b border-white/5 bg-white/[0.02] px-3 py-1.5">
        <div className="flex items-center gap-2">
          <FileCode size={12} className="text-zinc-500" />
          <span className="font-mono text-[10px] font-medium text-zinc-400 uppercase tracking-wider">
            {title || (isJson ? 'JSON' : 'OUTPUT')}
          </span>
        </div>

        {isLongContent && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              setIsExpanded(!isExpanded);
            }}
            className="flex items-center gap-1.5 rounded px-2 py-0.5 text-[10px] font-medium text-zinc-500 hover:bg-white/5 hover:text-zinc-300 transition-colors"
          >
            {isExpanded ? (
              <>
                <Minimize2 size={10} />
                <span>Collapse</span>
              </>
            ) : (
              <>
                <Maximize2 size={10} />
                <span>Expand</span>
              </>
            )}
          </button>
        )}
      </div>

      <div
        className={cn(
          "relative w-full overflow-hidden bg-[#0a0a0a]",
          isExpanded ? "max-h-none" : "max-h-[200px]"
        )}
      >
        <pre
          className={cn(
            "font-mono text-[11px] leading-relaxed p-3 overflow-x-auto scrollbar-thin scrollbar-thumb-zinc-800",
            !isExpanded && "overflow-y-hidden"
          )}
        >
          {isJson ? (
            <code dangerouslySetInnerHTML={{ __html: highlight(content) }} />
          ) : (
            <code className="text-zinc-300">{content}</code>
          )}
        </pre>
        {!isExpanded && isLongContent && (
          <div className="absolute bottom-0 left-0 right-0 h-12 bg-gradient-to-t from-[#0a0a0a] to-transparent pointer-events-none" />
        )}
      </div>
    </div>
  );
};

// --- 3. Tool Item Logic ---
interface ToolItemProps {
  tool: ToolCall;
  isLast: boolean;
}

const ToolItem: React.FC<ToolItemProps> = React.memo(({ tool, isLast }) => {
  // Auto-expand for running tools OR file_create/file_write with content
  const hasFileContent = (tool.name === 'file_create' || tool.name === 'file_write') && !!tool.args?.content;
  const [isOpen, setIsOpen] = useState(
    tool.status === 'executing' ||
    tool.status === 'pending' ||
    hasFileContent
  );
  const prevStatusRef = useRef(tool.status);

  const isRunning = tool.status === 'executing' || tool.status === 'pending';
  const isError = tool.status === 'failed' || tool.status === 'rejected';

  useEffect(() => {
    if (prevStatusRef.current !== tool.status) {
      // Don't collapse file_create/file_write cards that have content - keep content visible
      const shouldKeepOpen = (tool.name === 'file_create' || tool.name === 'file_write') && !!tool.args?.content;

      if (['complete', 'failed', 'rejected'].includes(tool.status) && !shouldKeepOpen) {
        setIsOpen(false);
      } else if (['executing', 'pending'].includes(tool.status)) {
        setIsOpen(true);
      }
      prevStatusRef.current = tool.status;
    }
  }, [tool.status, tool.name, tool.args?.content]);

  const filePath = tool.args?.path as string;

  // --- RESULT PARSING & CLEANUP ---
  const { displayData, simpleMessage, isFileList, fileList, isMultiFileResult, multiFileResults } = useMemo(() => {
    let raw = null;
    let msg = null;
    let isList = false;
    let listData = [];
    let isMultiFile = false;
    let multiFileData: Array<{ path: string; success: boolean; lines?: number; error?: string; content?: string }> = [];

    // Tools that should show simple success messages (not raw JSON)
    const simpleMessageTools = [
      'editor_open_file', 'editor_close_tab', 'editor_insert_text',
      'editor_get_active_file', 'editor_get_open_tabs', 'editor_get_selection',
      'file_create', 'file_delete', 'file_write', 'file_patch', 'file_exists',
      'folder_create', 'folder_delete',
      'workspace_info', 'workspace_tree',
      'shell_execute', 'shell_spawn', 'shell_kill',
      'grep', 'multi_file_read',
    ];

    // For file_create/file_write, always show the content being written
    if ((tool.name === 'file_create' || tool.name === 'file_write') && tool.args?.content) {
      raw = tool.args.content;
    } else if (tool.result) {
      try {
        const parsed = JSON.parse(tool.result);

        // 1. GREP RESULTS - Show summary only
        if (tool.name === 'grep' && parsed.success === true) {
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
        // 2. MULTI FILE READ - Show summary with file list
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
        // 3. FILE LIST (workspace_tree with tree)
        else if (parsed.tree && Array.isArray(parsed.tree)) {
          msg = `${parsed.tree.length} items in ${parsed.rootPath?.split(/[/\\]/).pop() || 'workspace'}`;
        }
        // 3. FILE LIST (workspace_list_files)
        else if (parsed.files && Array.isArray(parsed.files)) {
          isList = true;
          listData = parsed.files;
        }
        // 4. FILE READ (Extract 'content' only)
        else if (parsed.content && typeof parsed.content === 'string') {
          raw = parsed.content;
        }
        // 5. Tools that should show simple message
        else if (parsed.success === true && parsed.message && simpleMessageTools.includes(tool.name)) {
          msg = parsed.message;
        }
        // 6. workspace_info - show name and counts
        else if (tool.name === 'workspace_info' && parsed.success === true) {
          msg = parsed.hasWorkspace
            ? `${parsed.name}: ${parsed.totalFiles} files, ${parsed.totalFolders} folders`
            : 'No workspace open';
        }
        // 7. file_exists - show exists status
        else if (tool.name === 'file_exists' && parsed.success === true) {
          msg = parsed.exists ? 'File exists' : 'File does not exist';
        }
        // 8. FALLBACK - Only show raw JSON for unknown tools
        else if (!simpleMessageTools.includes(tool.name)) {
          raw = parsed;
        }
        // 9. For known tools without message, just show success
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
    };
  }, [tool.name, tool.args, tool.result]);


  return (
    <div className="group relative flex gap-3">
      {/* Left Timeline Track */}
      <div className="flex flex-col items-center w-5 flex-shrink-0 relative">
        {/* Connection Line */}
        <div
          className={cn(
            "absolute top-0 bottom-0 w-px transition-colors duration-300",
            isLast ? "bg-transparent h-4" : "bg-white/10 group-hover:bg-white/15"
          )}
        />

        {/* Status Dot/Icon */}
        <div
          className={cn(
            "relative z-10 flex h-5 w-5 items-center justify-center rounded-full ring-2 shadow-sm mt-3 backdrop-blur-md transition-all duration-300",
            isRunning
              ? "bg-[#111111] ring-blue-500/50 text-blue-400 scale-110"
              : isError
                ? "bg-[#111111] ring-red-500/50 text-red-400"
                : "bg-[#111111] ring-white/10 text-emerald-400 group-hover:ring-emerald-500/30"
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
            "overflow-hidden rounded-lg border bg-[#151515]/50 backdrop-blur-sm transition-all duration-200",
            isOpen
              ? "border-white/10 shadow-lg shadow-black/20 ring-1 ring-white/5"
              : "border-white/5 hover:bg-white/[0.04] hover:border-white/10"
          )}
        >
          {/* Header */}
          <button
            onClick={() => setIsOpen(!isOpen)}
            className="flex w-full items-center gap-3 px-3 py-2.5 text-left"
          >
            <span className={cn(
              "font-mono text-xs font-semibold tracking-tight transition-colors",
              isRunning ? "text-blue-300" : "text-zinc-300"
            )}>
              {tool.name}
            </span>

            {/* Path in Header */}
            {filePath && (
              <div className="flex min-w-0 items-center gap-1.5 overflow-hidden text-[11px] text-zinc-500">
                <ArrowRight size={10} className="text-zinc-600" />
                <span className="truncate font-mono opacity-70">{filePath}</span>
              </div>
            )}

            <div className="ml-auto flex items-center gap-3">
              <span className={cn(
                "text-[9px] uppercase tracking-wider font-semibold",
                isRunning ? "text-blue-400 animate-pulse" :
                  isError ? "text-red-400" : "text-emerald-500/50"
              )}>
                {tool.status}
              </span>
              <ChevronRight
                size={14}
                className={cn("text-zinc-600 transition-transform duration-200", isOpen && "rotate-90")}
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
              <div className="border-t border-white/5 bg-black/20 px-3 py-3 space-y-3">

                {/* Arguments (Cleaned) */}
                {Object.keys(tool.args || {}).filter(k => k !== 'content' && k !== 'path').length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {Object.entries(tool.args || {})
                      .filter(([key]) => key !== 'content' && key !== 'path')
                      .map(([key, value]) => (
                        <div
                          key={key}
                          className="flex items-center gap-1.5 rounded bg-white/5 px-2 py-1 text-[10px] border border-white/5 hover:border-white/10 transition-colors"
                        >
                          <span className="text-zinc-500">{key}</span>
                          <span className="text-zinc-300 font-mono">
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

                {/* 3. Simple Success Banner */}
                {simpleMessage && !tool.error && !isFileList && !isMultiFileResult && (
                  <div className="flex items-center gap-2 rounded border border-emerald-500/20 bg-emerald-500/5 px-3 py-2">
                    <Check size={12} className="text-emerald-400" />
                    <span className="font-mono text-[11px] text-emerald-100/80">
                      {simpleMessage}
                    </span>
                  </div>
                )}

                {/* 4. Code View (Now shows pure content for read_file) */}
                {(displayData || tool.error) && !isMultiFileResult && (
                  <CodeView
                    data={displayData}
                    error={tool.error}
                    title={tool.name.includes('file') ? 'FILE CONTENT' : undefined}
                  />
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}, (prev, next) => {
  return (
    prev.tool.id === next.tool.id &&
    prev.tool.status === next.tool.status &&
    prev.tool.result === next.tool.result &&
    prev.isLast === next.isLast
  );
});

export const ToolTimeline: React.FC<{ tools: ToolCall[] }> = ({ tools }) => {
  if (!tools || tools.length === 0) return null;
  return (
    <div className="space-y-0 relative w-full pl-1">
      {tools.map((tool, idx) => (
        <ToolItem key={tool.id} tool={tool} isLast={idx === tools.length - 1} />
      ))}
    </div>
  );
};