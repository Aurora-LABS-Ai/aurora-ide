/**
 * THEME ARCHITECTURE NOTICE:
 *
 * This project uses a centralized theme system. DO NOT use hardcoded colors.
 * Use theme tokens via CSS variables.
 */

import React, { useCallback, useRef, useState } from 'react';
import {
  RefreshCw,
  Plus,
  Minus,
  ChevronDown,
  ChevronRight,
  Upload,
  Download,
  AlertCircle,
} from 'lucide-react';
import clsx from 'clsx';
import { useGitStore } from '../../store/useGitStore';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { getLanguageFromExtension } from '../../lib/file-utils';
import { gitService, type GitFileChange } from '../../services/git';
import { GitFileItem } from './GitFileItem';
import { GitCommitInput } from './GitCommitInput';
import { GitBranchSelector } from './GitBranchSelector';
import { GitDiffModal } from './GitDiffModal';

interface GitDiffPreviewState {
  error: string | null;
  filePath: string;
  isLoading: boolean;
  language: string;
  modified: string;
  oldPath?: string;
  original: string;
  staged: boolean;
  status: string;
}

export const GitPanel: React.FC = () => {
  const rootPath = useWorkspaceStore((state) => state.rootPath);
  const {
    isLoading,
    isInitialized,
    isGitRepo,
    status,
    expandedSections,
    commitMessage,
    refresh,
    stageFile,
    unstageFile,
    stageAll,
    unstageAll,
    discardChanges,
    commit,
    pull,
    push,
    toggleSection,
    setCommitMessage,
  } = useGitStore();
  const [diffPreview, setDiffPreview] = useState<GitDiffPreviewState | null>(null);
  const diffRequestIdRef = useRef(0);
  const stagedCount = status?.staged.length ?? 0;
  const unstagedCount = (status?.unstaged.length ?? 0) + (status?.untracked.length ?? 0);
  const conflictedCount = status?.conflicted.length ?? 0;
  const canCommitChanges = stagedCount > 0 || unstagedCount > 0;
  const commitDisabledByState = conflictedCount > 0 || !canCommitChanges;

  const handleRefresh = useCallback(() => {
    refresh();
  }, [refresh]);

  const handleStageAll = useCallback(async () => {
    try {
      await stageAll();
    } catch (error) {
      console.error('Failed to stage all:', error);
    }
  }, [stageAll]);

  const handleUnstageAll = useCallback(async () => {
    try {
      await unstageAll();
    } catch (error) {
      console.error('Failed to unstage all:', error);
    }
  }, [unstageAll]);

  const handleCommit = useCallback(async () => {
    if (!commitMessage.trim()) return;
    if (conflictedCount > 0) return;

    try {
      // Smart commit: if nothing is staged but there are local changes,
      // stage everything first so commit is never blocked by section state.
      if (stagedCount === 0 && unstagedCount > 0) {
        await stageAll();
      }

      await commit(commitMessage.trim());
    } catch (error) {
      console.error('Failed to commit:', error);
    }
  }, [commit, commitMessage, conflictedCount, stagedCount, stageAll, unstagedCount]);

  const handlePull = useCallback(async () => {
    try {
      await pull();
    } catch (error) {
      console.error('Failed to pull:', error);
    }
  }, [pull]);

  const handlePush = useCallback(async () => {
    try {
      await push();
    } catch (error) {
      console.error('Failed to push:', error);
    }
  }, [push]);

  const handleCloseDiff = useCallback(() => {
    diffRequestIdRef.current += 1;
    setDiffPreview(null);
  }, []);

  const handleOpenDiff = useCallback(async (file: GitFileChange) => {
    const language = getLanguageFromExtension(file.path) || 'plaintext';
    const requestId = ++diffRequestIdRef.current;

    setDiffPreview({
      error: null,
      filePath: file.path,
      isLoading: true,
      language,
      modified: '',
      oldPath: file.oldPath,
      original: '',
      staged: file.staged,
      status: file.status,
    });

    if (!rootPath) {
      setDiffPreview((current) =>
        current && diffRequestIdRef.current === requestId
          ? {
              ...current,
              error: 'No workspace is open. Unable to load diff preview.',
              isLoading: false,
            }
          : current
      );
      return;
    }

    try {
      const versions = await gitService.getFileVersions(rootPath, file.path, file.staged, file.oldPath);
      if (diffRequestIdRef.current !== requestId) return;

      setDiffPreview((current) =>
        current
          ? {
              ...current,
              error: null,
              isLoading: false,
              modified: versions.modifiedContent,
              original: versions.originalContent,
            }
          : current
      );
    } catch (error) {
      if (diffRequestIdRef.current !== requestId) return;
      const message = error instanceof Error ? error.message : String(error);
      setDiffPreview((current) =>
        current
          ? {
              ...current,
              error: message || 'Failed to load diff preview.',
              isLoading: false,
            }
          : current
      );
    }
  }, [rootPath]);

  // Not initialized yet
  if (!isInitialized) {
    return (
      <div className="h-full flex flex-col" style={{ background: 'var(--aurora-sidebar-background)' }}>
        <PanelHeader onRefresh={handleRefresh} isLoading={isLoading} />
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center px-4">
            <RefreshCw className="w-8 h-8 mx-auto mb-2 animate-spin" style={{ color: 'var(--aurora-common-primary)' }} />
            <p className="text-xs" style={{ color: 'var(--aurora-sidebar-foreground)', opacity: 0.6 }}>
              Initializing...
            </p>
          </div>
        </div>
      </div>
    );
  }

  // Not a git repository
  if (!isGitRepo) {
    return (
      <div className="h-full flex flex-col" style={{ background: 'var(--aurora-sidebar-background)' }}>
        <PanelHeader onRefresh={handleRefresh} isLoading={isLoading} />
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center px-4">
            <AlertCircle className="w-8 h-8 mx-auto mb-2" style={{ color: 'var(--aurora-common-warning)' }} />
            <p className="text-sm font-medium mb-1" style={{ color: 'var(--aurora-sidebar-foreground)' }}>
              Not a Git Repository
            </p>
            <p className="text-xs" style={{ color: 'var(--aurora-sidebar-foreground)', opacity: 0.6 }}>
              Open a folder with a git repository to see source control.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col" style={{ background: 'var(--aurora-sidebar-background)' }}>
      {/* Header */}
      <PanelHeader
        onRefresh={handleRefresh}
        onPull={handlePull}
        onPush={handlePush}
        isLoading={isLoading}
        ahead={status?.ahead}
        behind={status?.behind}
      />

      {/* Branch Selector */}
      <div className="px-3 py-2 border-b" style={{ borderColor: 'var(--aurora-common-border)' }}>
        <GitBranchSelector />
      </div>

      {/* Commit Input */}
      <div className="px-3 py-2 border-b" style={{ borderColor: 'var(--aurora-common-border)' }}>
        <GitCommitInput
          value={commitMessage}
          onChange={setCommitMessage}
          onCommit={handleCommit}
          disabled={commitDisabledByState}
        />
      </div>

      {/* Scrollable Content */}
      <div className="flex-1 overflow-y-auto">
        {/* Conflicts Section */}
        {conflictedCount > 0 && (
          <CollapsibleSection
            title="Merge Conflicts"
            count={conflictedCount}
            isExpanded={expandedSections.has('conflicts')}
            onToggle={() => toggleSection('conflicts')}
            variant="danger"
          >
            {status?.conflicted.map((file) => (
              <GitFileItem
                key={file.path}
                file={file}
                onOpenDiff={handleOpenDiff}
                onStage={() => stageFile(file.path)}
                onDiscard={() => discardChanges(file.path)}
              />
            ))}
          </CollapsibleSection>
        )}

        {/* Staged Changes */}
        <CollapsibleSection
          title="Staged Changes"
          count={stagedCount}
          isExpanded={expandedSections.has('staged')}
          onToggle={() => toggleSection('staged')}
          actions={
            stagedCount > 0 ? (
              <button
                onClick={handleUnstageAll}
                className="p-1 rounded hover:bg-input/50 transition-colors"
                title="Unstage All"
                style={{ color: 'var(--aurora-sidebar-foreground)' }}
              >
                <Minus className="w-3.5 h-3.5" />
              </button>
            ) : null
          }
        >
          {status?.staged.map((file) => (
            <GitFileItem
              key={file.path}
              file={file}
              onOpenDiff={handleOpenDiff}
              onUnstage={() => unstageFile(file.path)}
            />
          ))}
          {stagedCount === 0 && (
            <p className="px-4 py-2 text-xs" style={{ color: 'var(--aurora-sidebar-foreground)', opacity: 0.5 }}>
              No staged changes
            </p>
          )}
        </CollapsibleSection>

        {/* Changes (Unstaged + Untracked) */}
        <CollapsibleSection
          title="Changes"
          count={unstagedCount}
          isExpanded={expandedSections.has('changes')}
          onToggle={() => toggleSection('changes')}
          actions={
            unstagedCount > 0 ? (
              <button
                onClick={handleStageAll}
                className="p-1 rounded hover:bg-input/50 transition-colors"
                title="Stage All"
                style={{ color: 'var(--aurora-sidebar-foreground)' }}
              >
                <Plus className="w-3.5 h-3.5" />
              </button>
            ) : null
          }
        >
          {status?.unstaged.map((file) => (
            <GitFileItem
              key={file.path}
              file={file}
              onOpenDiff={handleOpenDiff}
              onStage={() => stageFile(file.path)}
              onDiscard={() => discardChanges(file.path)}
            />
          ))}
          {status?.untracked.map((file) => (
            <GitFileItem
              key={file.path}
              file={file}
              onOpenDiff={handleOpenDiff}
              onStage={() => stageFile(file.path)}
              onDiscard={() => discardChanges(file.path)}
            />
          ))}
          {unstagedCount === 0 && (
            <p className="px-4 py-2 text-xs" style={{ color: 'var(--aurora-sidebar-foreground)', opacity: 0.5 }}>
              No changes
            </p>
          )}
        </CollapsibleSection>
      </div>

      <GitDiffModal
        error={diffPreview?.error}
        filePath={diffPreview?.filePath ?? ''}
        isLoading={diffPreview?.isLoading ?? false}
        isOpen={Boolean(diffPreview)}
        language={diffPreview?.language ?? 'plaintext'}
        modified={diffPreview?.modified ?? ''}
        oldPath={diffPreview?.oldPath}
        onClose={handleCloseDiff}
        original={diffPreview?.original ?? ''}
        staged={diffPreview?.staged ?? false}
        status={diffPreview?.status ?? 'modified'}
      />
    </div>
  );
};

// ============================================================================
// Sub-components
// ============================================================================

interface PanelHeaderProps {
  onRefresh: () => void;
  onPull?: () => void;
  onPush?: () => void;
  isLoading: boolean;
  ahead?: number;
  behind?: number;
}

const PanelHeader: React.FC<PanelHeaderProps> = ({
  onRefresh,
  onPull,
  onPush,
  isLoading,
  ahead = 0,
  behind = 0,
}) => {
  return (
    <div
      className="h-9 px-3 flex items-center justify-between border-b shrink-0"
      style={{
        background: 'var(--aurora-sidebar-background)',
        borderColor: 'var(--aurora-common-border)',
      }}
    >
      <span
        className="text-[11px] font-bold uppercase tracking-wide"
        style={{ color: 'var(--aurora-sidebar-foreground)', opacity: 0.7 }}
      >
        Source Control
      </span>
      <div className="flex items-center gap-1">
        {onPull && behind > 0 && (
          <button
            onClick={onPull}
            className="p-1.5 rounded hover:bg-input/50 transition-colors flex items-center gap-1"
            title={`Pull (${behind} behind)`}
            style={{ color: 'var(--aurora-sidebar-foreground)' }}
          >
            <Download className="w-3.5 h-3.5" />
            <span className="text-[10px]">{behind}</span>
          </button>
        )}
        {onPush && ahead > 0 && (
          <button
            onClick={onPush}
            className="p-1.5 rounded hover:bg-input/50 transition-colors flex items-center gap-1"
            title={`Push (${ahead} ahead)`}
            style={{ color: 'var(--aurora-sidebar-foreground)' }}
          >
            <Upload className="w-3.5 h-3.5" />
            <span className="text-[10px]">{ahead}</span>
          </button>
        )}
        <button
          onClick={onRefresh}
          disabled={isLoading}
          className="p-1.5 rounded hover:bg-input/50 transition-colors disabled:opacity-50"
          title="Refresh"
          style={{ color: 'var(--aurora-sidebar-foreground)' }}
        >
          <RefreshCw className={clsx("w-3.5 h-3.5", isLoading && "animate-spin")} />
        </button>
      </div>
    </div>
  );
};

interface CollapsibleSectionProps {
  title: string;
  count: number;
  isExpanded: boolean;
  onToggle: () => void;
  children: React.ReactNode;
  actions?: React.ReactNode;
  variant?: 'default' | 'danger';
}

const CollapsibleSection: React.FC<CollapsibleSectionProps> = ({
  title,
  count,
  isExpanded,
  onToggle,
  children,
  actions,
  variant = 'default',
}) => {
  return (
    <div className="border-b" style={{ borderColor: 'var(--aurora-common-border)' }}>
      <div
        role="button"
        onClick={onToggle}
        className="w-full px-3 py-2 flex items-center gap-2 hover:bg-sidebar-item-hover transition-colors cursor-pointer select-none"
      >
        {isExpanded ? (
          <ChevronDown className="w-3.5 h-3.5" style={{ color: 'var(--aurora-sidebar-foreground)', opacity: 0.6 }} />
        ) : (
          <ChevronRight className="w-3.5 h-3.5" style={{ color: 'var(--aurora-sidebar-foreground)', opacity: 0.6 }} />
        )}
        <span
          className="text-[11px] font-semibold uppercase tracking-wide flex-1 text-left"
          style={{
            color: variant === 'danger' ? 'var(--aurora-common-error)' : 'var(--aurora-sidebar-foreground)',
            opacity: variant === 'danger' ? 1 : 0.8,
          }}
        >
          {title}
        </span>
        {count > 0 && (
          <span
            className="text-[10px] px-1.5 py-0.5 rounded-full"
            style={{
              background: variant === 'danger' ? 'var(--aurora-common-error)' : 'var(--aurora-common-primary)',
              color:
                variant === 'danger'
                  ? 'var(--aurora-common-error-foreground)'
                  : 'var(--aurora-common-primary-foreground)',
            }}
          >
            {count}
          </span>
        )}
        {actions && (
          <div onClick={(e) => e.stopPropagation()} className="flex items-center">
            {actions}
          </div>
        )}
      </div>
      {isExpanded && <div>{children}</div>}
    </div>
  );
};

export default GitPanel;
