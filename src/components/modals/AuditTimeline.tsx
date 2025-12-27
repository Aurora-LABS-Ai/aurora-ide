import React from 'react';
import { useUiStore } from '../../store/useUiStore';
import { useAuditStore, type AuditEntry } from '../../store/useAuditStore';
import { X, CheckCircle, XCircle, Clock, AlertTriangle, Loader2, Terminal, FileText, FolderOpen, Code } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import clsx from 'clsx';

// Get icon for tool category
const getToolIcon = (toolName: string) => {
  if (toolName.startsWith('file_') || toolName === 'grep' || toolName === 'multi_file_read') {
    return FileText;
  }
  if (toolName.startsWith('shell_')) {
    return Terminal;
  }
  if (toolName.startsWith('folder_') || toolName.startsWith('workspace_')) {
    return FolderOpen;
  }
  if (toolName.startsWith('editor_')) {
    return Code;
  }
  return Code;
};

// Format duration
const formatDuration = (ms: number | undefined) => {
  if (!ms) return '';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
};

// Get primary argument for display
const getPrimaryArg = (_toolName: string, args: Record<string, unknown>): string => {
  if (args.path) return String(args.path);
  if (args.paths) return `${(args.paths as string[]).length} files`;
  if (args.command) return String(args.command).substring(0, 50);
  if (args.content) return `${String(args.content).length} chars`;
  if (args.pattern) return String(args.pattern);
  return '';
};

const AuditEntryCard: React.FC<{ entry: AuditEntry }> = ({ entry }) => {
  const Icon = getToolIcon(entry.toolName);
  const primaryArg = getPrimaryArg(entry.toolName, entry.args);

  return (
    <div className="ml-5 relative animate-in slide-in-from-left-2 duration-200">
      {/* Timeline dot */}
      <div className={clsx(
        "absolute -left-[23px] top-2 w-3 h-3 rounded-full border-2 border-[#18181b]",
        entry.status === 'executed' ? "bg-emerald-500" :
        entry.status === 'rejected' ? "bg-red-500" :
        entry.status === 'failed' ? "bg-orange-500" :
        entry.status === 'executing' ? "bg-amber-500" :
        "bg-zinc-500"
      )} />

      <div className="bg-white/[0.02] border border-white/5 rounded-lg p-3 hover:bg-white/[0.03] transition-colors">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-2.5 min-w-0 flex-1">
            <div className={clsx(
              "p-1.5 rounded-md mt-0.5",
              entry.status === 'executed' ? "bg-emerald-500/10 text-emerald-400" :
              entry.status === 'failed' ? "bg-orange-500/10 text-orange-400" :
              entry.status === 'rejected' ? "bg-red-500/10 text-red-400" :
              "bg-zinc-500/10 text-zinc-400"
            )}>
              <Icon size={14} />
            </div>

            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 mb-1">
                <span className="font-mono text-[11px] font-semibold text-emerald-400">
                  {entry.toolName}
                </span>
                {entry.duration && (
                  <span className="text-[9px] text-zinc-500 font-mono">
                    {formatDuration(entry.duration)}
                  </span>
                )}
              </div>

              {primaryArg && (
                <p className="text-[11px] text-zinc-400 font-mono truncate">
                  {primaryArg}
                </p>
              )}

              <p className="text-[10px] text-zinc-600 mt-1">
                {formatDistanceToNow(entry.timestamp, { addSuffix: true })}
              </p>
            </div>
          </div>

          <div className="flex flex-col items-end gap-1.5">
            {/* Status badge */}
            <div className={clsx(
              "flex items-center gap-1 text-[9px] font-medium px-1.5 py-0.5 rounded",
              entry.status === 'executed' ? "bg-emerald-500/20 text-emerald-400" :
              entry.status === 'rejected' ? "bg-red-500/20 text-red-400" :
              entry.status === 'failed' ? "bg-orange-500/20 text-orange-400" :
              entry.status === 'executing' ? "bg-amber-500/20 text-amber-400" :
              "bg-zinc-500/20 text-zinc-400"
            )}>
              {entry.status === 'executed' && <CheckCircle size={10} />}
              {entry.status === 'rejected' && <XCircle size={10} />}
              {entry.status === 'failed' && <AlertTriangle size={10} />}
              {entry.status === 'executing' && <Loader2 size={10} className="animate-spin" />}
              {entry.status === 'pending' && <Clock size={10} />}
              {entry.status.toUpperCase()}
            </div>

            {/* Risk level */}
            <div className={clsx(
              "flex items-center gap-1 text-[9px] px-1.5 py-0.5 rounded",
              entry.riskLevel === 'high' ? "bg-red-500/10 text-red-400" :
              entry.riskLevel === 'medium' ? "bg-amber-500/10 text-amber-400" :
              "bg-zinc-500/10 text-zinc-500"
            )}>
              <AlertTriangle size={8} />
              {entry.riskLevel.toUpperCase()}
            </div>
          </div>
        </div>

        {/* Error message if failed */}
        {entry.error && (
          <div className="mt-2 p-2 bg-red-500/10 border border-red-500/20 rounded text-[10px] text-red-400 font-mono">
            {entry.error}
          </div>
        )}

        {/* Result preview (collapsed) */}
        {entry.result && entry.status === 'executed' && (
          <details className="mt-2">
            <summary className="text-[10px] text-zinc-500 cursor-pointer hover:text-zinc-400">
              View result
            </summary>
            <div className="mt-1 p-2 bg-black/20 rounded text-[10px] text-zinc-400 font-mono max-h-20 overflow-auto">
              {entry.result}
            </div>
          </details>
        )}
      </div>
    </div>
  );
};

export const AuditTimeline: React.FC = () => {
  const { isAuditOpen, setAuditOpen } = useUiStore();
  const { entries, clearEntries } = useAuditStore();

  if (!isAuditOpen) return null;

  // Get recent entries (newest first)
  const recentEntries = entries.slice(0, 100);

  // Stats
  const stats = {
    total: entries.length,
    executed: entries.filter(e => e.status === 'executed').length,
    failed: entries.filter(e => e.status === 'failed').length,
    rejected: entries.filter(e => e.status === 'rejected').length,
  };

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 animate-in fade-in duration-150">
      <div className="bg-[#18181b] border border-white/10 rounded-xl shadow-2xl shadow-black/50 w-[550px] h-[70vh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="h-12 border-b border-white/5 flex items-center justify-between px-4 bg-white/[0.02]">
          <div className="flex items-center gap-3">
            <h2 className="text-[13px] font-semibold text-zinc-100">Audit Timeline</h2>
            <div className="flex items-center gap-2 text-[10px]">
              <span className="text-zinc-500">{stats.total} total</span>
              <span className="text-emerald-400">{stats.executed} executed</span>
              {stats.failed > 0 && <span className="text-orange-400">{stats.failed} failed</span>}
              {stats.rejected > 0 && <span className="text-red-400">{stats.rejected} rejected</span>}
            </div>
          </div>
          <div className="flex items-center gap-2">
            {entries.length > 0 && (
              <button
                onClick={clearEntries}
                className="px-2 py-1 text-[10px] text-zinc-500 hover:text-zinc-300 hover:bg-white/5 rounded transition-colors"
              >
                Clear
              </button>
            )}
            <button
              onClick={() => setAuditOpen(false)}
              className="p-1.5 rounded-md text-zinc-500 hover:bg-white/5 hover:text-zinc-300 transition-colors"
            >
              <X size={16} />
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-4">
          {recentEntries.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-center">
              <div className="w-12 h-12 rounded-full bg-white/5 flex items-center justify-center mb-3">
                <Terminal size={20} className="text-zinc-600" />
              </div>
              <p className="text-[13px] text-zinc-400 mb-1">No tool executions yet</p>
              <p className="text-[11px] text-zinc-600 max-w-[250px]">
                Tool executions will appear here as the AI assistant works on your requests.
              </p>
            </div>
          ) : (
            <div className="relative border-l border-white/10 ml-2 space-y-3">
              {recentEntries.map((entry) => (
                <AuditEntryCard key={entry.id} entry={entry} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
