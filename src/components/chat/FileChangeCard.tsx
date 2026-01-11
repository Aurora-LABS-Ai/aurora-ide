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
            case 'create': return <FilePlus size={14} className="text-success" />;
            case 'write': return <FileEdit size={14} className="text-info" />;
            case 'patch': return <FileCode size={14} className="text-warning" />;
            case 'delete': return <FileMinus size={14} className="text-danger" />;
            default: return <FileCode size={14} className="text-text-disabled" />;
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
                    <span className="flex items-center gap-1 text-[10px] font-medium text-diff-added">
                        <Check size={10} /> Accepted
                    </span>
                );
            case 'rejected':
                return (
                    <span className="flex items-center gap-1 text-[10px] font-medium text-diff-removed">
                        <X size={10} /> Rejected
                    </span>
                );
            default:
                return (
                    <span className="text-[10px] font-medium text-warning animate-pulse">
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
                ? "bg-sidebar border-warning/50"
                : change.status === 'accepted'
                    ? "bg-sidebar border-success/50"
                    : "bg-sidebar border-danger/50 opacity-60"
        )}>
            {/* Header */}
            <div className="px-3 py-2.5 border-b border-border flex items-center justify-between">
                <div className="flex items-center gap-2.5 min-w-0">
                    {getOperationIcon()}
                    <div className="flex flex-col min-w-0">
                        <span className="font-mono text-[11px] font-semibold text-text-primary truncate">
                            {change.fileName}
                        </span>
                        <span className="font-mono text-[9px] text-text-disabled truncate">
                            {change.filePath}
                        </span>
                    </div>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                    <span className="text-[10px] text-text-secondary font-mono">
                        {lineCount} lines
                    </span>
                    {getStatusBadge()}
                </div>
            </div>

            {/* Content Preview */}
            <div className="relative">
                <div className="flex items-center justify-between border-b border-border bg-panel-header px-3 py-1.5">
                    <div className="flex items-center gap-2">
                        <Eye size={10} className="text-text-secondary" />
                        <span className="font-mono text-[10px] font-medium text-text-secondary uppercase tracking-wider">
                            {getOperationLabel()}
                        </span>
                    </div>
                    <div className="flex items-center gap-2">
                        <button
                            onClick={handleCopy}
                            className="flex items-center gap-1 text-[10px] text-text-secondary hover:text-text-primary transition-colors"
                        >
                            <Copy size={10} />
                            {copied ? 'Copied!' : 'Copy'}
                        </button>
                        {hasMore && (
                            <button
                                onClick={() => setIsExpanded(!isExpanded)}
                                className="flex items-center gap-1 text-[10px] text-text-secondary hover:text-text-primary transition-colors"
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
                    "bg-editor overflow-hidden transition-all duration-200",
                    !isExpanded && hasMore && "max-h-[300px]"
                )}>
                    <pre className="font-mono text-[11px] leading-relaxed p-3 overflow-x-auto text-text-primary scrollbar-thin scrollbar-thumb-border">
                        <code>{displayContent}</code>
                    </pre>
                    {!isExpanded && hasMore && (
                        <div className="absolute bottom-0 left-0 right-0 h-16 bg-gradient-to-t from-editor to-transparent pointer-events-none" />
                    )}
                </div>
            </div>

            {/* Action Buttons */}
            {change.status === 'pending' && (
                <div className="px-3 py-2.5 border-t border-border flex items-center gap-2">
                    <button
                        onClick={handleAccept}
                        disabled={isAccepting}
                        className={clsx(
                            "flex-1 flex items-center justify-center gap-2 py-2 px-4 rounded-md text-[12px] font-semibold transition-all",
                            "bg-success/20 hover:bg-success/30 text-success border border-success/30",
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
                            "text-text-secondary hover:text-danger hover:bg-danger/10 border border-transparent hover:border-danger/20",
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
            "flex items-center justify-between px-4 py-2 bg-warning/10 border-b border-warning/20",
            className
        )}>
            <span className="text-[12px] font-medium text-warning">
                {pending.length} pending file {pending.length === 1 ? 'change' : 'changes'}
            </span>
            <div className="flex items-center gap-2">
                <button
                    onClick={handleAcceptAll}
                    className="flex items-center gap-1 text-[11px] font-medium text-diff-added hover:text-success transition-colors"
                >
                    <Check size={12} />
                    Accept All
                </button>
                <button
                    onClick={rejectAll}
                    className="flex items-center gap-1 text-[11px] font-medium text-muted-foreground hover:text-error transition-colors"
                >
                    <X size={12} />
                    Reject All
                </button>
            </div>
        </div>
    );
};
