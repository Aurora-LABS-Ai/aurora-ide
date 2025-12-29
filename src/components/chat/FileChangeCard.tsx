/**
 * FileChangeCard Component
 * 
 * Shows pending file changes with Accept/Reject buttons.
 * Modeled after ToolProposalCard for consistent UX.
 */

import React, { useState, useMemo } from 'react';
import {
    Check,
    X,
    FileCode,
    FilePlus,
    FileMinus,
    FileEdit,
    ChevronDown,
    ChevronUp,
    Copy,
    Eye
} from 'lucide-react';
import { usePendingChangesStore } from '../../store/usePendingChangesStore';
import clsx from 'clsx';

interface FileChangeCardProps {
    changeId: string;
    toolCallId?: string;
}

export const FileChangeCard: React.FC<FileChangeCardProps> = ({ changeId, toolCallId }) => {
    const [isExpanded, setIsExpanded] = useState(true);
    const [isAccepting, setIsAccepting] = useState(false);
    const [copied, setCopied] = useState(false);

    const { getChange, getChangeByToolId, acceptChange, rejectChange } = usePendingChangesStore();

    // Get change by ID or tool ID
    const change = useMemo(() => {
        if (changeId) return getChange(changeId);
        if (toolCallId) return getChangeByToolId(toolCallId);
        return undefined;
    }, [changeId, toolCallId, getChange, getChangeByToolId]);

    if (!change) return null;

    const handleAccept = async () => {
        setIsAccepting(true);
        try {
            await acceptChange(change.id);
        } finally {
            setIsAccepting(false);
        }
    };

    const handleReject = () => {
        rejectChange(change.id);
    };

    const handleCopy = async () => {
        await navigator.clipboard.writeText(change.content);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    const getOperationIcon = () => {
        switch (change.operation) {
            case 'create': return <FilePlus size={14} className="text-emerald-400" />;
            case 'write': return <FileEdit size={14} className="text-blue-400" />;
            case 'patch': return <FileCode size={14} className="text-amber-400" />;
            case 'delete': return <FileMinus size={14} className="text-red-400" />;
            default: return <FileCode size={14} className="text-zinc-400" />;
        }
    };

    const getOperationLabel = () => {
        switch (change.operation) {
            case 'create': return 'Create File';
            case 'write': return 'Write File';
            case 'patch': return 'Patch File';
            case 'delete': return 'Delete File';
            default: return 'Modify File';
        }
    };

    const getStatusBadge = () => {
        switch (change.status) {
            case 'accepted':
                return (
                    <span className="flex items-center gap-1 text-[10px] font-medium text-emerald-400">
                        <Check size={10} /> Accepted
                    </span>
                );
            case 'rejected':
                return (
                    <span className="flex items-center gap-1 text-[10px] font-medium text-red-400">
                        <X size={10} /> Rejected
                    </span>
                );
            default:
                return (
                    <span className="text-[10px] font-medium text-amber-400 animate-pulse">
                        Pending Approval
                    </span>
                );
        }
    };

    const lineCount = change.content.split('\n').length;
    const previewLines = 15;
    const lines = change.content.split('\n');
    const displayContent = isExpanded
        ? change.content
        : lines.slice(0, previewLines).join('\n');
    const hasMore = lines.length > previewLines;

    return (
        <div className={clsx(
            "mt-3 rounded-lg overflow-hidden border transition-all duration-200",
            change.status === 'pending'
                ? "bg-amber-500/[0.03] border-amber-500/20"
                : change.status === 'accepted'
                    ? "bg-emerald-500/[0.03] border-emerald-500/20"
                    : "bg-red-500/[0.03] border-red-500/20 opacity-60"
        )}>
            {/* Header */}
            <div className="px-3 py-2.5 border-b border-white/5 flex items-center justify-between">
                <div className="flex items-center gap-2.5 min-w-0">
                    {getOperationIcon()}
                    <div className="flex flex-col min-w-0">
                        <span className="font-mono text-[11px] font-semibold text-zinc-200 truncate">
                            {change.fileName}
                        </span>
                        <span className="font-mono text-[9px] text-zinc-500 truncate">
                            {change.filePath}
                        </span>
                    </div>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                    <span className="text-[10px] text-zinc-500 font-mono">
                        {lineCount} lines
                    </span>
                    {getStatusBadge()}
                </div>
            </div>

            {/* Content Preview */}
            <div className="relative">
                <div className="flex items-center justify-between border-b border-white/5 bg-white/[0.02] px-3 py-1.5">
                    <div className="flex items-center gap-2">
                        <Eye size={10} className="text-zinc-500" />
                        <span className="font-mono text-[10px] font-medium text-zinc-400 uppercase tracking-wider">
                            {getOperationLabel()}
                        </span>
                    </div>
                    <div className="flex items-center gap-2">
                        <button
                            onClick={handleCopy}
                            className="flex items-center gap-1 text-[10px] text-zinc-500 hover:text-zinc-300 transition-colors"
                        >
                            <Copy size={10} />
                            {copied ? 'Copied!' : 'Copy'}
                        </button>
                        {hasMore && (
                            <button
                                onClick={() => setIsExpanded(!isExpanded)}
                                className="flex items-center gap-1 text-[10px] text-zinc-500 hover:text-zinc-300 transition-colors"
                            >
                                {isExpanded ? (
                                    <>
                                        <ChevronUp size={10} />
                                        Collapse
                                    </>
                                ) : (
                                    <>
                                        <ChevronDown size={10} />
                                        Show all
                                    </>
                                )}
                            </button>
                        )}
                    </div>
                </div>

                <div className={clsx(
                    "bg-[#0a0a0a] overflow-hidden transition-all duration-200",
                    !isExpanded && hasMore && "max-h-[300px]"
                )}>
                    <pre className="font-mono text-[11px] leading-relaxed p-3 overflow-x-auto text-zinc-300 scrollbar-thin scrollbar-thumb-zinc-800">
                        <code>{displayContent}</code>
                    </pre>
                    {!isExpanded && hasMore && (
                        <div className="absolute bottom-0 left-0 right-0 h-16 bg-gradient-to-t from-[#0a0a0a] to-transparent pointer-events-none" />
                    )}
                </div>
            </div>

            {/* Action Buttons */}
            {change.status === 'pending' && (
                <div className="px-3 py-2.5 border-t border-white/5 flex items-center gap-2">
                    <button
                        onClick={handleAccept}
                        disabled={isAccepting}
                        className={clsx(
                            "flex-1 flex items-center justify-center gap-2 py-2 px-4 rounded-md text-[12px] font-semibold transition-all",
                            "bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-300 border border-emerald-500/30",
                            isAccepting && "opacity-50 cursor-not-allowed"
                        )}
                    >
                        <Check size={14} />
                        {isAccepting ? 'Applying...' : 'Accept'}
                    </button>
                    <button
                        onClick={handleReject}
                        disabled={isAccepting}
                        className={clsx(
                            "px-4 py-2 rounded-md text-[12px] font-medium transition-all",
                            "text-zinc-400 hover:text-red-400 hover:bg-red-500/10 border border-transparent hover:border-red-500/20",
                            isAccepting && "opacity-50 cursor-not-allowed"
                        )}
                    >
                        <X size={14} />
                    </button>
                </div>
            )}
        </div>
    );
};

// Bulk actions component for multiple pending changes
interface PendingChangesBarProps {
    className?: string;
}

export const PendingChangesBar: React.FC<PendingChangesBarProps> = ({ className }) => {
    const { getPendingChanges, acceptAll, rejectAll } = usePendingChangesStore();
    const pending = getPendingChanges();

    if (pending.length === 0) return null;

    const handleAcceptAll = async () => {
        await acceptAll();
    };

    return (
        <div className={clsx(
            "flex items-center justify-between px-4 py-2 bg-amber-500/10 border-b border-amber-500/20",
            className
        )}>
            <span className="text-[12px] font-medium text-amber-300">
                {pending.length} pending file {pending.length === 1 ? 'change' : 'changes'}
            </span>
            <div className="flex items-center gap-2">
                <button
                    onClick={handleAcceptAll}
                    className="flex items-center gap-1 text-[11px] font-medium text-emerald-400 hover:text-emerald-300 transition-colors"
                >
                    <Check size={12} />
                    Accept All
                </button>
                <button
                    onClick={rejectAll}
                    className="flex items-center gap-1 text-[11px] font-medium text-zinc-400 hover:text-red-400 transition-colors"
                >
                    <X size={12} />
                    Reject All
                </button>
            </div>
        </div>
    );
};
