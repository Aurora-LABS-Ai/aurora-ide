/**
 * THEME ARCHITECTURE NOTICE:
 *
 * This component uses the centralized theme system via CSS variables.
 * All colors use var(--aurora-{category}-{token}) format.
 *
 * Shows files modified by the agent, similar to git panel uncommitted files.
 *
 * See: DOCS/theme-dev.md for full token reference
 */

import React, { useState, useMemo } from 'react';
import {
  ChevronDown,
  ChevronRight,
  FileEdit,
  RefreshCw,
  PanelRightClose,
} from 'lucide-react';
import { useAuditStore } from '../../store/useAuditStore';
import { useEditorStore } from '../../store/useEditorStore';
import { useSettingsStore } from '../../store/useSettingsStore';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { resolveExplorerIcon } from '../../lib/icon-registry';

type FileChangeType = 'created' | 'modified' | 'deleted';

interface FileChange {
  path: string;
  fileName: string;
  changeType: FileChangeType;
  timestamp: number;
  toolName?: string;
}

interface AgentChangesTreeProps {
  className?: string;
  onCollapse?: () => void;
}

export const AgentChangesTree: React.FC<AgentChangesTreeProps> = ({ className, onCollapse }) => {
  const { entries } = useAuditStore();
  const { openFile } = useEditorStore();
  const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set(['modified', 'created']));

  // Extract file changes from audit entries
  const fileChanges = useMemo<FileChange[]>(() => {
    const changesMap = new Map<string, FileChange>();

    entries.forEach((entry) => {
      // Only look at file-related tools that executed successfully
      if (entry.status !== 'executed') return;

      const path = entry.args?.path as string | undefined;
      if (!path) return;

      let changeType: FileChangeType | null = null;

      if (entry.toolName === 'file_create') {
        changeType = 'created';
      } else if (['file_write', 'file_patch', 'search_replace', 'multi_search_replace'].includes(entry.toolName)) {
        changeType = 'modified';
      } else if (entry.toolName === 'file_delete') {
        changeType = 'deleted';
      }

      if (changeType) {
        const fileName = path.split(/[/\\]/).pop() || path;
        // Keep the latest change for each file
        const existing = changesMap.get(path);
        if (!existing || entry.timestamp > existing.timestamp) {
          changesMap.set(path, {
            path,
            fileName,
            changeType,
            timestamp: entry.timestamp,
            toolName: entry.toolName,
          });
        }
      }
    });

    return Array.from(changesMap.values()).sort((a, b) => b.timestamp - a.timestamp);
  }, [entries]);

  // Group by change type
  const grouped = useMemo(() => {
    const groups: Record<FileChangeType, FileChange[]> = {
      created: [],
      modified: [],
      deleted: [],
    };

    fileChanges.forEach((change) => {
      groups[change.changeType].push(change);
    });

    return groups;
  }, [fileChanges]);

  const toggleSection = (section: string) => {
    setExpandedSections((prev) => {
      const next = new Set(prev);
      if (next.has(section)) {
        next.delete(section);
      } else {
        next.add(section);
      }
      return next;
    });
  };

  const handleFileClick = async (change: FileChange) => {
    if (change.changeType === 'deleted') return;

    try {
      const { readFileContent } = await import('../../lib/tauri');
      const { resolvePath } = await import('../../tools/utils/path-resolver');

      const fullPath = resolvePath(change.path);
      const content = await readFileContent(fullPath);
      const ext = change.fileName.split('.').pop()?.toLowerCase() || '';
      const langMap: Record<string, string> = {
        ts: 'typescript',
        tsx: 'typescript',
        js: 'javascript',
        jsx: 'javascript',
        json: 'json',
        css: 'css',
        scss: 'scss',
        html: 'html',
        md: 'markdown',
        rs: 'rust',
        py: 'python',
        go: 'go',
      };
      const language = langMap[ext] || 'plaintext';

      openFile(fullPath, change.fileName, content, language);
    } catch (error) {
      console.error('Failed to open file:', error);
    }
  };

  const getChangeColor = (type: FileChangeType) => {
    switch (type) {
      case 'created':
        return 'var(--aurora-common-diff-added)';
      case 'modified':
        return 'var(--aurora-common-diff-modified)';
      case 'deleted':
        return 'var(--aurora-common-diff-removed)';
    }
  };

  const totalChanges = fileChanges.length;

  return (
    <div
      className={`h-full flex flex-col ${className || ''}`}
      style={{
        background: 'color-mix(in srgb, var(--aurora-sidebar-background) 88%, var(--aurora-editor-background) 12%)',
      }}
    >
      {/* Header */}
      <div
        className="flex h-10 shrink-0 items-center justify-between border-b px-3"
        style={{
          background: 'color-mix(in srgb, var(--aurora-title-bar-background) 76%, var(--aurora-sidebar-background) 24%)',
          borderColor: 'color-mix(in srgb, var(--aurora-common-border) 72%, transparent)',
        }}
      >
        <div className="flex items-center gap-2">
          <span
            className="text-[11px] font-bold uppercase tracking-wide"
            style={{ color: 'var(--aurora-sidebar-foreground)', opacity: 0.7 }}
          >
            Agent Changes
          </span>
          {totalChanges > 0 && (
            <span
              className="text-[10px] px-1.5 py-0.5 rounded-full"
              style={{
                background: 'var(--aurora-common-primary)',
                color: 'var(--aurora-common-primary-foreground)',
              }}
            >
              {totalChanges}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <button
            className="flex h-6 w-6 items-center justify-center transition-colors outline-none focus:outline-none"
            style={{
              color: 'var(--aurora-sidebar-foreground)',
              background: 'transparent',
              border: 'none',
              borderRadius: 4,
              opacity: 0.65,
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.opacity = '1';
              e.currentTarget.style.backgroundColor =
                'color-mix(in srgb, var(--aurora-common-primary) 8%, transparent)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.opacity = '0.65';
              e.currentTarget.style.backgroundColor = 'transparent';
            }}
            title="Refresh"
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
          {onCollapse && (
            <button
              onClick={onCollapse}
              className="flex h-6 w-6 items-center justify-center transition-colors outline-none focus:outline-none"
              style={{
                color: 'var(--aurora-sidebar-foreground)',
                background: 'transparent',
                border: 'none',
                borderRadius: 4,
                opacity: 0.65,
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.opacity = '1';
                e.currentTarget.style.backgroundColor =
                  'color-mix(in srgb, var(--aurora-common-primary) 8%, transparent)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.opacity = '0.65';
                e.currentTarget.style.backgroundColor = 'transparent';
              }}
              title="Hide changes panel"
            >
              <PanelRightClose className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto scrollbar-thin">
        {totalChanges === 0 ? (
          <div
            className="flex flex-col items-center justify-center h-full px-4 text-center"
          >
            <FileEdit
              className="w-8 h-8 mb-2"
              style={{ color: 'var(--aurora-common-muted-foreground)', opacity: 0.5 }}
            />
            <p
              className="text-sm font-medium mb-1"
              style={{ color: 'var(--aurora-sidebar-foreground)' }}
            >
              No Changes Yet
            </p>
            <p
              className="text-xs"
              style={{ color: 'var(--aurora-sidebar-foreground)', opacity: 0.6 }}
            >
              Files modified by the agent will appear here.
            </p>
          </div>
        ) : (
          <>
            {/* Modified Section */}
            {grouped.modified.length > 0 && (
              <CollapsibleSection
                title="Modified"
                count={grouped.modified.length}
                isExpanded={expandedSections.has('modified')}
                onToggle={() => toggleSection('modified')}
                color="var(--aurora-common-diff-modified)"
              >
                {grouped.modified.map((change) => (
                  <FileItem
                    key={change.path}
                    change={change}
                    onClick={() => handleFileClick(change)}
                    color={getChangeColor(change.changeType)}
                  />
                ))}
              </CollapsibleSection>
            )}

            {/* Created Section */}
            {grouped.created.length > 0 && (
              <CollapsibleSection
                title="Created"
                count={grouped.created.length}
                isExpanded={expandedSections.has('created')}
                onToggle={() => toggleSection('created')}
                color="var(--aurora-common-diff-added)"
              >
                {grouped.created.map((change) => (
                  <FileItem
                    key={change.path}
                    change={change}
                    onClick={() => handleFileClick(change)}
                    color={getChangeColor(change.changeType)}
                  />
                ))}
              </CollapsibleSection>
            )}

            {/* Deleted Section */}
            {grouped.deleted.length > 0 && (
              <CollapsibleSection
                title="Deleted"
                count={grouped.deleted.length}
                isExpanded={expandedSections.has('deleted')}
                onToggle={() => toggleSection('deleted')}
                color="var(--aurora-common-diff-removed)"
              >
                {grouped.deleted.map((change) => (
                  <FileItem
                    key={change.path}
                    change={change}
                    onClick={() => handleFileClick(change)}
                    color={getChangeColor(change.changeType)}
                    disabled
                  />
                ))}
              </CollapsibleSection>
            )}
          </>
        )}
      </div>
    </div>
  );
};

// Sub-components

interface CollapsibleSectionProps {
  title: string;
  count: number;
  isExpanded: boolean;
  onToggle: () => void;
  children: React.ReactNode;
  color: string;
}

const CollapsibleSection: React.FC<CollapsibleSectionProps> = ({
  title,
  count,
  isExpanded,
  onToggle,
  children,
  color,
}) => {
  return (
    <div
      className="border-b"
      style={{ borderColor: 'var(--aurora-common-border)' }}
    >
      <button
        onClick={onToggle}
        className="w-full px-3 py-2 flex items-center gap-2 hover:bg-sidebar-item-hover transition-colors cursor-pointer select-none"
      >
        {isExpanded ? (
          <ChevronDown
            className="w-3.5 h-3.5"
            style={{ color: 'var(--aurora-sidebar-foreground)', opacity: 0.6 }}
          />
        ) : (
          <ChevronRight
            className="w-3.5 h-3.5"
            style={{ color: 'var(--aurora-sidebar-foreground)', opacity: 0.6 }}
          />
        )}
        <span
          className="text-[11px] font-semibold uppercase tracking-wide flex-1 text-left"
          style={{ color }}
        >
          {title}
        </span>
        <span
          className="text-[10px] px-1.5 py-0.5 rounded-full"
          style={{
            background: color,
            color: 'var(--aurora-common-primary-foreground)',
          }}
        >
          {count}
        </span>
      </button>
      {isExpanded && <div>{children}</div>}
    </div>
  );
};

interface FileItemProps {
  change: FileChange;
  onClick: () => void;
  color: string;
  disabled?: boolean;
}

const FileItem: React.FC<FileItemProps> = ({ change, onClick, color, disabled }) => {
  const explorerIconPack = useSettingsStore((state) => state.explorerIconPack);
  // Get relative path for display
  const { rootPath } = useWorkspaceStore.getState();
  const displayPath = rootPath && change.path.startsWith(rootPath)
    ? change.path.slice(rootPath.length + 1)
    : change.path;
  const dirPath = displayPath.includes('/') || displayPath.includes('\\')
    ? displayPath.substring(0, displayPath.lastIndexOf(/[/\\]/.test(displayPath) ? (displayPath.includes('/') ? '/' : '\\') : '/'))
    : '';

  // Lightweight line count for display
  const [lineCount, setLineCount] = React.useState<number | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    const fetchLines = async () => {
      if (change.changeType === 'deleted') return;
      try {
        const { readFileContent } = await import('../../lib/tauri');
        const { resolvePath } = await import('../../tools/utils/path-resolver');
        const fullPath = resolvePath(change.path);
        const content = await readFileContent(fullPath);
        if (cancelled) return;
        const lines = content ? content.split(/\r?\n/).length : 0;
        setLineCount(lines);
      } catch {
        if (!cancelled) setLineCount(null);
      }
    };
    fetchLines();
    return () => { cancelled = true; };
  }, [change.changeType, change.path]);

  const changeLabel = change.changeType === 'created'
    ? 'New file'
    : change.changeType === 'modified'
      ? 'Modified'
      : 'Deleted';
  const icon = resolveExplorerIcon(
    { name: change.fileName, path: change.path, isFolder: false },
    explorerIconPack,
  );

  return (
    <div
      onClick={disabled ? undefined : onClick}
      className={`group flex items-center gap-2 px-4 py-1.5 transition-colors ${disabled ? 'opacity-50 cursor-not-allowed' : 'hover:bg-sidebar-item-hover cursor-pointer'}`}
    >
      <img
        src={icon.src || '/material-icons/file.svg'}
        alt=""
        className="w-4 h-4 flex-shrink-0"
        style={{ opacity: disabled ? 0.5 : 1 }}
      />
      <div className="flex-1 min-w-0">
        <span
          className="text-[12px] truncate block"
          style={{ color: 'var(--aurora-sidebar-foreground)' }}
        >
          {change.fileName}
        </span>
        {dirPath && (
          <span
            className="text-[10px] truncate block"
            style={{ color: 'var(--aurora-common-muted-foreground)' }}
          >
            {dirPath}
          </span>
        )}
      </div>
      <div className="flex items-center gap-1">
        <span
          className="text-[10px] font-mono px-1.5 py-0.5 rounded-full"
          style={{ color }}
        >
          {changeLabel}
        </span>
        {lineCount !== null && (
          <span
            className="text-[10px] font-mono text-text-disabled"
            title={`${lineCount} lines`}
          >
            {lineCount} lines
          </span>
        )}
      </div>
    </div>
  );
};

export default AgentChangesTree;
