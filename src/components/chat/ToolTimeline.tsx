import React, { useState, useEffect } from 'react';
import { ChevronRight, Check, X, Loader2, Terminal, FileText, FolderOpen } from 'lucide-react';
import clsx from 'clsx';
import type { ToolCall } from '../../types';

interface ToolPillProps {
  tool: ToolCall;
}

const ToolPill: React.FC<ToolPillProps> = ({ tool }) => {
  const isComplete = tool.status === 'complete';
  const isExecuting = tool.status === 'executing';
  const isFailed = tool.status === 'failed';
  const isPending = tool.status === 'pending';
  
  const [isOpen, setIsOpen] = useState(false);
  
  // Auto-expand when executing, auto-collapse when done
  useEffect(() => {
    if (isExecuting || isPending) {
      setIsOpen(true);
    } else if (isComplete || isFailed) {
      // Auto-collapse when done
      setIsOpen(false);
    }
  }, [isExecuting, isPending, isComplete, isFailed]);

  const getStatusIcon = () => {
    if (isExecuting || isPending) return <Loader2 className="w-3 h-3 animate-spin text-primary" />;
    if (isFailed) return <X className="w-3 h-3 text-danger" />;
    if (isComplete) return <Check className="w-3 h-3 text-success" />;
    return <Terminal className="w-3 h-3 text-text-disabled" />;
  };

  // Get tool icon based on name
  const getToolIcon = () => {
    if (tool.name.includes('file')) return <FileText className="w-3 h-3" />;
    if (tool.name.includes('folder') || tool.name.includes('workspace')) return <FolderOpen className="w-3 h-3" />;
    return <Terminal className="w-3 h-3" />;
  };

  // Format result for display
  const formatResult = (result: string): string => {
    try {
      const parsed = JSON.parse(result);
      return JSON.stringify(parsed, null, 2);
    } catch {
      return result;
    }
  };

  // Check if this is a file creation tool with content
  const isFileCreateWithContent = (tool.name === 'file_create' || tool.name === 'file_write') && tool.args?.content;
  const contentPreview = isFileCreateWithContent ? String(tool.args.content) : null;

  return (
    <div className="my-1">
      {/* Tool Header */}
      <button 
        onClick={() => setIsOpen(!isOpen)}
        className={clsx(
          "flex items-center gap-1.5 px-2 py-1 rounded text-[11px] font-medium transition-colors",
          "border border-border hover:bg-input/50",
          (isExecuting || isPending) ? "text-primary border-primary/30" : 
          isComplete ? "text-success border-success/30" :
          isFailed ? "text-danger border-danger/30" :
          "text-text-secondary"
        )}
      >
        {getStatusIcon()}
        <span className="font-mono">{tool.name}</span>
        {tool.args?.path && (
          <span className="text-[10px] text-text-disabled truncate max-w-[120px]">
            {String(tool.args.path)}
          </span>
        )}
        {(isExecuting || isPending) && (
          <span className="text-[10px] text-primary animate-pulse">Running...</span>
        )}
        <ChevronRight className={clsx(
          "w-3 h-3 transition-transform ml-auto",
          isOpen && "rotate-90"
        )} />
      </button>

      {/* Details */}
      {isOpen && (
        <div className="mt-1 ml-1 rounded border border-border bg-titlebar overflow-hidden">
          {/* Show content being written for file_create/file_write */}
          {contentPreview && (isExecuting || isPending) && (
            <div className="px-2 py-1.5 border-b border-border bg-editor">
              <div className="flex items-center gap-1 mb-1">
                {getToolIcon()}
                <span className="text-[10px] text-text-disabled">Writing content:</span>
              </div>
              <pre className="text-[10px] font-mono text-text-secondary leading-relaxed whitespace-pre-wrap break-words max-h-40 overflow-y-auto scrollbar-thin">
                {contentPreview.length > 500 ? contentPreview.slice(0, 500) + '\n...' : contentPreview}
              </pre>
            </div>
          )}

          {/* Args (excluding content if already shown) */}
          {tool.args && Object.keys(tool.args).length > 0 && (
            <div className="px-2 py-1.5 bg-input/50 border-b border-border">
              <div className="flex flex-wrap gap-1.5">
                {Object.entries(tool.args)
                  .filter(([k]) => !(contentPreview && k === 'content'))
                  .map(([k, v]) => (
                    <span key={k} className="text-[10px] font-mono text-text-secondary">
                      <span className="text-text-disabled">{k}:</span>{' '}
                      <span className="text-text-primary break-all">
                        {String(v).length > 50 ? String(v).slice(0, 50) + '...' : String(v)}
                      </span>
                    </span>
                  ))}
              </div>
            </div>
          )}

          {/* Output */}
          {tool.result ? (
            <div className="p-2 max-h-32 overflow-y-auto overflow-x-hidden scrollbar-thin">
              <pre className="text-[10px] font-mono text-success leading-relaxed whitespace-pre-wrap break-words">
                {formatResult(tool.result)}
              </pre>
            </div>
          ) : tool.error ? (
            <div className="p-2 max-h-32 overflow-y-auto overflow-x-hidden scrollbar-thin">
              <pre className="text-[10px] font-mono text-danger leading-relaxed whitespace-pre-wrap break-words">
                {tool.error}
              </pre>
            </div>
          ) : (isExecuting || isPending) && !contentPreview ? (
            <div className="p-2">
              <div className="h-1 bg-input rounded overflow-hidden">
                <div className="h-full w-1/3 bg-primary/50 animate-pulse rounded" />
              </div>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
};

interface ToolTimelineProps {
  tools: ToolCall[];
}

export const ToolTimeline: React.FC<ToolTimelineProps> = ({ tools }) => {
  if (!tools || tools.length === 0) return null;

  return (
    <div className="flex flex-col gap-0.5 my-1">
      {tools.map((tool) => (
        <ToolPill key={tool.id} tool={tool} />
      ))}
    </div>
  );
};
