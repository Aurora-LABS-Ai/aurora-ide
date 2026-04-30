/**
 * THEME ARCHITECTURE NOTICE:
 * Uses centralized theme system with CSS variables.
 * See: src/types/theme.ts for TypeScript interfaces
 */

import React, { useEffect, useState, useCallback, useRef } from 'react';
import {
  Database,
  FolderOpen,
  RefreshCw,
  Trash2,
  CheckCircle,
  AlertCircle,
  Clock,
  Loader2,
  Info,
  ExternalLink,
  Plus,
  X,
  ChevronRight,
  ChevronDown,
  Folder,
  Save,
} from 'lucide-react';
import clsx from 'clsx';
import { IdeSwitch } from '../ui/IdeSwitch';
import { IdeSelect } from '../ui/IdeSelect';
import { useSemanticStore } from '../../store/useSemanticStore';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { open } from '@tauri-apps/plugin-dialog';
import { semanticService } from '../../services/semantic';
import { readDirectory, type FileEntry } from '../../lib/tauri';
import { settingsCardStyle, settingsRowDividerColor } from './settings-shared';
import {
  Section,
  FormRow,
  FormRowLast,
  FormBlock,
  StatusPill,
  ActionButton,
  IconButton,
  IdeTextInput,
  IdeTextArea,
  IdeSlider,
} from './settings-primitives';

export const SemanticSettingsTab: React.FC = () => {
  const {
    settings,
    settingsLoading,
    currentIndex,
    allIndexes,
    isIndexing,
    indexProgress,
    loadSettings,
    saveSettings,
    setModelPath,
    loadIndexes,
    loadCurrentIndex,
    startIndexing,
    cancelIndexing,
    deleteIndex,
  } = useSemanticStore();

  const { rootPath } = useWorkspaceStore();
  const [localModelPath, setLocalModelPath] = useState('');
  const [modelPathDirty, setModelPathDirty] = useState(false);
  const [savingModelPath, setSavingModelPath] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [semanticDataDir, setSemanticDataDir] = useState<string | null>(null);
  const [showDirPicker, setShowDirPicker] = useState(false);
  const [workspaceDirs, setWorkspaceDirs] = useState<FileEntry[]>([]);
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());
  const [dirChildren, setDirChildren] = useState<Record<string, FileEntry[]>>({});
  
  // Local state for weight sliders (to avoid DB writes on every mouse move)
  const [localLexicalWeight, setLocalLexicalWeight] = useState(0.4);
  const [localSemanticWeight, setLocalSemanticWeight] = useState(0.6);
  const weightSaveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  
  // Local state for text inputs (debounced save on blur or after 1s idle)
  const [localIgnoredDirs, setLocalIgnoredDirs] = useState('');
  const [localIgnoredPatterns, setLocalIgnoredPatterns] = useState('');
  // Workspace-specific exclusions (from currentIndex, not settings)
  const [localExcludedFiles, setLocalExcludedFiles] = useState('');
  const [localExcludedDirs, setLocalExcludedDirs] = useState<string[]>([]);
  const textSaveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const exclusionSaveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Load settings and indexes on mount
  useEffect(() => {
    loadSettings();
    loadIndexes();
    if (rootPath) {
      loadCurrentIndex(rootPath);
    }
    // Load workspace-local semantic index directory path.
    semanticService.getSemanticDataDirectory(rootPath).then(setSemanticDataDir).catch(() => {
      setSemanticDataDir(null);
    });
  }, [loadSettings, loadIndexes, loadCurrentIndex, rootPath]);

  // Sync local model path with settings
  useEffect(() => {
    if (settings?.modelPath !== undefined) {
      setLocalModelPath(settings.modelPath || '');
      setModelPathDirty(false);
    }
  }, [settings?.modelPath]);

  // Sync local weights with settings
  useEffect(() => {
    if (settings) {
      setLocalLexicalWeight(settings.lexicalWeight ?? 0.4);
      setLocalSemanticWeight(settings.semanticWeight ?? 0.6);
    }
  }, [settings?.lexicalWeight, settings?.semanticWeight]);

  // Sync local text inputs with global settings (ignored dirs/patterns)
  useEffect(() => {
    if (settings) {
      setLocalIgnoredDirs(settings.ignoredDirectories?.join(', ') || '');
      setLocalIgnoredPatterns(settings.ignoredPatterns?.join(', ') || '');
    }
  }, [settings?.ignoredDirectories, settings?.ignoredPatterns]);

  // Sync workspace-specific exclusions from currentIndex (not settings)
  useEffect(() => {
    if (currentIndex) {
      setLocalExcludedFiles(currentIndex.excludedFiles?.join('\n') || '');
      setLocalExcludedDirs(currentIndex.excludedDirectories || []);
    } else {
      // Clear when no workspace index
      setLocalExcludedFiles('');
      setLocalExcludedDirs([]);
    }
  }, [currentIndex?.id, currentIndex?.excludedFiles, currentIndex?.excludedDirectories]);

  // Cleanup timeouts on unmount
  useEffect(() => {
    return () => {
      if (weightSaveTimeoutRef.current) {
        clearTimeout(weightSaveTimeoutRef.current);
      }
      if (textSaveTimeoutRef.current) {
        clearTimeout(textSaveTimeoutRef.current);
      }
      if (exclusionSaveTimeoutRef.current) {
        clearTimeout(exclusionSaveTimeoutRef.current);
      }
    };
  }, []);

  const handleBrowseModel = async () => {
    const selected = await open({
      directory: true,
      multiple: false,
      title: 'Select ONNX Model Directory',
    });

    if (selected && typeof selected === 'string') {
      setLocalModelPath(selected);
      setModelPathDirty(selected !== (settings?.modelPath || ''));
    }
  };

  // Only update local state - no validation or DB save on keystroke
  const handleModelPathChange = (path: string) => {
    setLocalModelPath(path);
    setModelPathDirty(path !== (settings?.modelPath || ''));
  };

  // Save model path - just saves the path, no validation (validation happens on Index)
  const handleSaveModelPath = async () => {
    if (savingModelPath) return;
    
    setSavingModelPath(true);
    try {
      const pathToSave = localModelPath.trim() || null;
      await setModelPath(pathToSave);
      setModelPathDirty(false);
    } finally {
      setSavingModelPath(false);
    }
  };

  // Debounced weight change - updates local state immediately, saves to DB after 500ms
  const handleWeightChange = useCallback((lexical: number) => {
    const semantic = 1 - lexical;
    setLocalLexicalWeight(lexical);
    setLocalSemanticWeight(semantic);
    
    // Clear existing timeout
    if (weightSaveTimeoutRef.current) {
      clearTimeout(weightSaveTimeoutRef.current);
    }
    
    // Debounce the save - only save after user stops dragging for 500ms
    weightSaveTimeoutRef.current = setTimeout(() => {
      saveSettings({ lexicalWeight: lexical, semanticWeight: semantic });
    }, 500);
  }, [saveSettings]);

  // Debounced text input save for GLOBAL settings (ignored dirs/patterns)
  const debouncedTextSave = useCallback((field: string, value: string) => {
    if (textSaveTimeoutRef.current) {
      clearTimeout(textSaveTimeoutRef.current);
    }
    
    textSaveTimeoutRef.current = setTimeout(() => {
      if (field === 'ignoredDirectories') {
        saveSettings({ ignoredDirectories: value.split(',').map(s => s.trim()).filter(Boolean) });
      } else if (field === 'ignoredPatterns') {
        saveSettings({ ignoredPatterns: value.split(',').map(s => s.trim()).filter(Boolean) });
      }
    }, 1000);
  }, [saveSettings]);

  // Immediate save on blur for GLOBAL settings
  const handleTextBlur = useCallback((field: string, value: string) => {
    if (textSaveTimeoutRef.current) {
      clearTimeout(textSaveTimeoutRef.current);
      textSaveTimeoutRef.current = null;
    }
    
    if (field === 'ignoredDirectories') {
      saveSettings({ ignoredDirectories: value.split(',').map(s => s.trim()).filter(Boolean) });
    } else if (field === 'ignoredPatterns') {
      saveSettings({ ignoredPatterns: value.split(',').map(s => s.trim()).filter(Boolean) });
    }
  }, [saveSettings]);

  // Save workspace-specific exclusions (debounced)
  const saveWorkspaceExclusions = useCallback((excludedFiles: string[], excludedDirs: string[]) => {
    if (!rootPath) return;
    
    if (exclusionSaveTimeoutRef.current) {
      clearTimeout(exclusionSaveTimeoutRef.current);
    }
    
    exclusionSaveTimeoutRef.current = setTimeout(() => {
      semanticService.updateWorkspaceExclusions(rootPath, excludedFiles, excludedDirs)
        .then(() => {
          // Reload current index to get updated exclusions
          loadCurrentIndex(rootPath);
        })
        .catch(err => console.error('Failed to save workspace exclusions:', err));
    }, 1000);
  }, [rootPath, loadCurrentIndex]);

  // Immediate save workspace exclusions on blur
  const handleExclusionBlur = useCallback(() => {
    if (!rootPath) return;
    
    if (exclusionSaveTimeoutRef.current) {
      clearTimeout(exclusionSaveTimeoutRef.current);
      exclusionSaveTimeoutRef.current = null;
    }
    
    const excludedFiles = localExcludedFiles.split('\n').map(s => s.trim()).filter(Boolean);
    semanticService.updateWorkspaceExclusions(rootPath, excludedFiles, localExcludedDirs)
      .then(() => loadCurrentIndex(rootPath))
      .catch(err => console.error('Failed to save workspace exclusions:', err));
  }, [rootPath, localExcludedFiles, localExcludedDirs, loadCurrentIndex]);

  const handleStartIndexing = async () => {
    if (!rootPath) return;
    const workspaceName = rootPath.split(/[/\\]/).pop() || 'Workspace';
    await startIndexing(rootPath, workspaceName);
  };

  const handleDeleteIndex = async () => {
    if (!currentIndex || !rootPath) return;
    if (confirm('Are you sure you want to delete this index? You will need to re-index the workspace.')) {
      await deleteIndex(currentIndex.id, rootPath);
    }
  };

  // Load workspace directories for the picker
  const loadWorkspaceDirs = useCallback(async () => {
    if (!rootPath) return;
    try {
      const entries = await readDirectory(rootPath, { includeHidden: false });
      // Filter to only directories, exclude common non-source directories
      const dirs = entries.filter(e => e.is_dir && !e.name.startsWith('.'));
      setWorkspaceDirs(dirs);
    } catch (err) {
      console.error('Failed to load workspace directories:', err);
    }
  }, [rootPath]);

  // Load children of a directory
  const loadDirChildren = useCallback(async (dirPath: string) => {
    try {
      const entries = await readDirectory(dirPath, { includeHidden: false });
      const dirs = entries.filter(e => e.is_dir && !e.name.startsWith('.'));
      setDirChildren(prev => ({ ...prev, [dirPath]: dirs }));
    } catch (err) {
      console.error('Failed to load directory children:', err);
    }
  }, []);

  // Toggle directory expansion
  const toggleDirExpand = useCallback(async (dirPath: string) => {
    const newExpanded = new Set(expandedDirs);
    if (newExpanded.has(dirPath)) {
      newExpanded.delete(dirPath);
    } else {
      newExpanded.add(dirPath);
      if (!dirChildren[dirPath]) {
        await loadDirChildren(dirPath);
      }
    }
    setExpandedDirs(newExpanded);
  }, [expandedDirs, dirChildren, loadDirChildren]);

  // Add directory to workspace exclusion list
  const addExcludedDir = useCallback((dirPath: string) => {
    if (!rootPath) return;
    // Convert to relative path
    const relativePath = dirPath.replace(rootPath, '').replace(/^[/\\]+/, '');
    if (!relativePath) return;
    
    if (!localExcludedDirs.includes(relativePath)) {
      const newDirs = [...localExcludedDirs, relativePath];
      setLocalExcludedDirs(newDirs);
      const excludedFiles = localExcludedFiles.split('\n').map(s => s.trim()).filter(Boolean);
      saveWorkspaceExclusions(excludedFiles, newDirs);
    }
  }, [rootPath, localExcludedDirs, localExcludedFiles, saveWorkspaceExclusions]);

  // Remove directory from workspace exclusion list
  const removeExcludedDir = useCallback((relativePath: string) => {
    if (!rootPath) return;
    const newDirs = localExcludedDirs.filter(d => d !== relativePath);
    setLocalExcludedDirs(newDirs);
    const excludedFiles = localExcludedFiles.split('\n').map(s => s.trim()).filter(Boolean);
    saveWorkspaceExclusions(excludedFiles, newDirs);
  }, [rootPath, localExcludedDirs, localExcludedFiles, saveWorkspaceExclusions]);

  // Open directory picker
  const openDirPicker = useCallback(() => {
    loadWorkspaceDirs();
    setShowDirPicker(true);
  }, [loadWorkspaceDirs]);

  const formatBytes = (bytes: number): string => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'ready':
        return <CheckCircle className="w-4 h-4 text-success" />;
      case 'indexing':
        return <Loader2 className="w-4 h-4 text-primary animate-spin" />;
      case 'pending':
        return <Clock className="w-4 h-4 text-warning" />;
      case 'error':
        return <AlertCircle className="w-4 h-4 text-danger" />;
      default:
        return <Clock className="w-4 h-4 text-text-disabled" />;
    }
  };

  if (settingsLoading) {
    return (
      <div className="flex h-40 items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-primary" />
      </div>
    );
  }

  const indexBadge = currentIndex ? (
    <StatusPill
      variant={
        currentIndex.status === 'ready'
          ? 'success'
          : currentIndex.status === 'indexing'
            ? 'info'
            : currentIndex.status === 'error'
              ? 'danger'
              : 'warning'
      }
    >
      {currentIndex.status}
    </StatusPill>
  ) : (
    <StatusPill variant="neutral">Not indexed</StatusPill>
  );

  return (
    <div className="space-y-6 pb-2">
      {/* ============================================================ */}
      {/* Enable / Embedding model                                      */}
      {/* ============================================================ */}
      <Section
        title="Semantic Search"
        description="AI-powered code search using local ONNX embeddings. Recommended model: Qwen3 Embedding 0.6B."
        badge={
          settings?.enabled ? (
            <StatusPill variant="success">Enabled</StatusPill>
          ) : (
            <StatusPill variant="neutral">Disabled</StatusPill>
          )
        }
      >
        <FormRow
          label="Enable semantic search"
          hint="Uses the configured ONNX embedding model to power semantic and hybrid search."
        >
          <IdeSwitch
            checked={!!settings?.enabled}
            onChange={(next) => saveSettings({ enabled: next })}
            ariaLabel="Toggle semantic search"
            variant="primary"
            size="sm"
          />
        </FormRow>

        <FormRowLast
          label="ONNX model directory"
          hint="Folder containing the ONNX model and tokenizer. Click Save or press Enter to apply."
          align="top"
        >
          <div className="flex w-[320px] gap-1.5">
            <IdeTextInput
              value={localModelPath}
              onChange={(e) => handleModelPathChange(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && modelPathDirty && handleSaveModelPath()}
              placeholder="Path to Qwen3 ONNX model directory"
              className={clsx('font-mono', modelPathDirty && 'border-warning')}
              style={
                modelPathDirty
                  ? {
                      border: '1px solid color-mix(in srgb, var(--aurora-common-warning) 50%, transparent)',
                    }
                  : undefined
              }
            />
            <IconButton
              ariaLabel="Browse for model"
              title="Browse for model directory"
              onClick={handleBrowseModel}
              variant="secondary"
            >
              <FolderOpen className="h-3.5 w-3.5" />
            </IconButton>
            <IconButton
              ariaLabel="Save model path"
              title={modelPathDirty ? 'Save model path' : 'No changes to save'}
              onClick={handleSaveModelPath}
              disabled={!modelPathDirty || savingModelPath}
              variant={modelPathDirty ? 'primary' : 'secondary'}
            >
              {savingModelPath ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Save className="h-3.5 w-3.5" />
              )}
            </IconButton>
          </div>
        </FormRowLast>

        {!localModelPath && (
          <div
            className="flex items-start gap-2 px-4 py-3 text-[11.5px]"
            style={{
              backgroundColor:
                'color-mix(in srgb, var(--aurora-common-info) 10%, transparent)',
              borderTop: `1px solid color-mix(in srgb, var(--aurora-common-info) 25%, transparent)`,
            }}
          >
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-info" />
            <div className="text-text-secondary">
              <span className="font-medium text-text-primary">No model configured. </span>
              Select the local Qwen3 ONNX folder before indexing. Aurora stores each
              workspace's index inside that workspace's <code className="font-mono">.aurora</code>{' '}
              directory.
            </div>
          </div>
        )}
        {modelPathDirty && (
          <div
            className="flex items-start gap-2 px-4 py-2.5 text-[11.5px]"
            style={{
              backgroundColor:
                'color-mix(in srgb, var(--aurora-common-warning) 10%, transparent)',
              borderTop: `1px solid color-mix(in srgb, var(--aurora-common-warning) 25%, transparent)`,
            }}
          >
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
            <span className="text-text-secondary">
              Unsaved model path changes — click Save or press Enter.
            </span>
          </div>
        )}
      </Section>

      {/* ============================================================ */}
      {/* Current workspace index                                      */}
      {/* ============================================================ */}
      <Section
        title="Current Workspace Index"
        description={
          rootPath
            ? rootPath
            : 'Open a workspace to manage its index.'
        }
        badge={rootPath ? indexBadge : <StatusPill variant="neutral">No workspace</StatusPill>}
      >
        {!rootPath ? (
          <FormBlock divided={false}>
            <p className="text-[11.5px] text-text-secondary">
              Open a workspace before indexing.
            </p>
          </FormBlock>
        ) : currentIndex ? (
          <>
            {/* Stats */}
            {currentIndex.status === 'ready' && (
              <div
                className="grid grid-cols-3 divide-x"
                style={{
                  borderBottom: `1px solid ${settingsRowDividerColor}`,
                }}
              >
                {([
                  ['Documents', currentIndex.documentCount.toLocaleString()],
                  ['Chunks', currentIndex.chunkCount.toLocaleString()],
                  ['Size', formatBytes(currentIndex.totalBytes)],
                ] as const).map(([label, value]) => (
                  <div
                    key={label}
                    className="px-4 py-3"
                    style={{ borderColor: settingsRowDividerColor }}
                  >
                    <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-text-disabled">
                      {label}
                    </p>
                    <p className="mt-1 text-[15px] font-mono font-semibold text-text-primary">
                      {value}
                    </p>
                  </div>
                ))}
              </div>
            )}

            {currentIndex.errorMessage && (
              <FormBlock>
                <p className="text-[11.5px] text-danger">{currentIndex.errorMessage}</p>
              </FormBlock>
            )}

            {/* Progress */}
            {isIndexing && (
              <FormBlock>
                <div className="flex items-center justify-between text-[11px]">
                  <span className="capitalize text-text-secondary">
                    {indexProgress?.phase || 'Starting'}…
                  </span>
                  <span className="font-mono text-text-disabled">
                    {indexProgress ? `${indexProgress.percentage.toFixed(0)}%` : '0%'}
                  </span>
                </div>
                <div className="mt-2 h-1 overflow-hidden rounded-full bg-input">
                  <div
                    className="h-full bg-primary transition-all duration-300"
                    style={{ width: `${indexProgress?.percentage || 0}%` }}
                  />
                </div>
                {indexProgress?.currentFile && (
                  <p className="mt-1.5 truncate text-[10px] font-mono text-text-disabled">
                    {indexProgress.currentFile}
                  </p>
                )}
              </FormBlock>
            )}

            {/* Actions */}
            <FormBlock divided={false}>
              <div className="flex items-center justify-between gap-3">
                <p className="text-[11.5px] text-text-secondary">
                  {isIndexing
                    ? 'Aurora is indexing this workspace.'
                    : currentIndex.status === 'ready'
                      ? 'Index is ready. Re-index after large code changes.'
                      : 'Index needs attention.'}
                </p>
                <div className="flex items-center gap-1.5">
                  {isIndexing ? (
                    <ActionButton
                      variant="danger"
                      icon={<AlertCircle className="h-3 w-3" />}
                      onClick={() => cancelIndexing(currentIndex.id)}
                    >
                      Cancel
                    </ActionButton>
                  ) : (
                    <ActionButton
                      variant="primary"
                      icon={<RefreshCw className="h-3 w-3" />}
                      onClick={handleStartIndexing}
                    >
                      Re-index
                    </ActionButton>
                  )}
                  <IconButton
                    ariaLabel="Delete index"
                    title="Delete index"
                    onClick={handleDeleteIndex}
                    variant="danger"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </IconButton>
                </div>
              </div>
            </FormBlock>
          </>
        ) : (
          <FormBlock divided={false}>
            <div className="flex items-center justify-between gap-3">
              <p className="text-[11.5px] text-text-secondary">
                This workspace has not been indexed yet.
              </p>
              <ActionButton
                variant="primary"
                icon={
                  isIndexing ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <Database className="h-3 w-3" />
                  )
                }
                onClick={handleStartIndexing}
                disabled={isIndexing}
              >
                Index workspace
              </ActionButton>
            </div>
          </FormBlock>
        )}
      </Section>

      {/* ============================================================ */}
      {/* Search settings                                               */}
      {/* ============================================================ */}
      <Section
        title="Search Behavior"
        description="Choose how Aurora ranks results across keyword and semantic relevance."
      >
        <FormRow label="Search mode" hint="Hybrid blends both signals; lexical or semantic-only override the mix.">
          <IdeSelect
            ariaLabel="Select semantic search mode"
            align="end"
            className="min-w-[220px]"
            options={[
              {
                label: 'Hybrid',
                value: 'hybrid',
                description: 'Recommended — blends keyword and meaning',
              },
              {
                label: 'Lexical only',
                value: 'lexical',
                description: 'Keyword matching, no embeddings',
              },
              {
                label: 'Semantic only',
                value: 'semantic',
                description: 'Pure embedding similarity',
              },
            ]}
            onChange={(nextValue) =>
              saveSettings({
                searchMode: String(nextValue) as 'lexical' | 'semantic' | 'hybrid',
              })
            }
            value={settings?.searchMode || 'hybrid'}
          />
        </FormRow>

        {settings?.searchMode === 'hybrid' && (
          <>
            <FormRow
              label="Lexical weight"
              hint="Higher values favor exact keyword matches."
            >
              <IdeSlider
                value={localLexicalWeight}
                min={0}
                max={1}
                step={0.05}
                onChange={(v) => handleWeightChange(v)}
                ariaLabel="Lexical weight"
                formatValue={(v) => `${Math.round(v * 100)}%`}
                trackWidth={140}
              />
            </FormRow>
            <FormRowLast
              label="Semantic weight"
              hint="Higher values favor meaning-based matches."
            >
              <IdeSlider
                value={localSemanticWeight}
                min={0}
                max={1}
                step={0.05}
                onChange={(v) => handleWeightChange(1 - v)}
                ariaLabel="Semantic weight"
                formatValue={(v) => `${Math.round(v * 100)}%`}
                trackWidth={140}
              />
            </FormRowLast>
          </>
        )}
      </Section>

      {/* ============================================================ */}
      {/* Advanced                                                      */}
      {/* ============================================================ */}
      <Section
        title="Advanced"
        description="Indexing exclusions, file size cap, and storage details."
        badge={
          <button
            type="button"
            onClick={() => setShowAdvanced(!showAdvanced)}
            className="inline-flex items-center gap-1 text-[11px] font-medium text-text-secondary hover:text-text-primary"
          >
            {showAdvanced ? 'Hide' : 'Show'}
            <ChevronDown
              className={clsx(
                'h-3 w-3 transition-transform',
                showAdvanced && 'rotate-180',
              )}
            />
          </button>
        }
      >
        {showAdvanced ? (
          <>
            <FormRow
              label="Auto-index on workspace open"
              hint="Automatically index a workspace the first time it's opened."
            >
              <IdeSwitch
                checked={!!settings?.autoIndex}
                onChange={(next) => saveSettings({ autoIndex: next })}
                ariaLabel="Toggle auto-index on workspace open"
                variant="primary"
                size="sm"
              />
            </FormRow>

            <FormRow label="Max file size" hint="Files larger than this are skipped during indexing.">
              <IdeSelect
                ariaLabel="Select semantic max file size"
                align="end"
                className="min-w-[140px]"
                options={[
                  { label: '512 KB', value: 524288 },
                  { label: '1 MB', value: 1048576 },
                  { label: '2 MB', value: 2097152 },
                  { label: '5 MB', value: 5242880 },
                ]}
                onChange={(nextValue) => saveSettings({ maxFileSize: Number(nextValue) })}
                value={settings?.maxFileSize || 1048576}
              />
            </FormRow>

            <FormRow
              label="Ignored directories"
              hint="Comma-separated list applied to every workspace."
              align="top"
            >
              <IdeTextInput
                value={localIgnoredDirs}
                onChange={(e) => {
                  setLocalIgnoredDirs(e.target.value);
                  debouncedTextSave('ignoredDirectories', e.target.value);
                }}
                onBlur={(e) => handleTextBlur('ignoredDirectories', e.target.value)}
                placeholder="node_modules, target, dist"
                className="w-[300px] font-mono"
              />
            </FormRow>

            <FormRow
              label="Ignored file patterns"
              hint="Comma-separated globs applied to every workspace."
              align="top"
            >
              <IdeTextInput
                value={localIgnoredPatterns}
                onChange={(e) => {
                  setLocalIgnoredPatterns(e.target.value);
                  debouncedTextSave('ignoredPatterns', e.target.value);
                }}
                onBlur={(e) => handleTextBlur('ignoredPatterns', e.target.value)}
                placeholder="*.min.js, *.map, *.lock"
                className="w-[300px] font-mono"
              />
            </FormRow>

            {/* Workspace-specific exclusions */}
            {rootPath && currentIndex ? (
              <>
                <FormRow
                  label="Excluded files (this workspace)"
                  hint="One path per line. Re-index to apply."
                  align="top"
                >
                  <IdeTextArea
                    value={localExcludedFiles}
                    onChange={(e) => {
                      setLocalExcludedFiles(e.target.value);
                      const excludedFiles = e.target.value
                        .split('\n')
                        .map((s) => s.trim())
                        .filter(Boolean);
                      saveWorkspaceExclusions(excludedFiles, localExcludedDirs);
                    }}
                    onBlur={handleExclusionBlur}
                    placeholder="src/generated/types.ts&#10;src/proto/generated.rs"
                    rows={3}
                    className="w-[300px] font-mono"
                  />
                </FormRow>

                <FormRow
                  label="Excluded directories (this workspace)"
                  hint="Click Browse to pick directories from the workspace tree."
                  align="top"
                >
                  <div className="flex w-[300px] flex-col gap-2">
                    <ActionButton
                      variant="secondary"
                      icon={<Plus className="h-3 w-3" />}
                      onClick={openDirPicker}
                      disabled={!rootPath}
                    >
                      Browse directories
                    </ActionButton>
                    {localExcludedDirs.length > 0 && (
                      <div className="flex flex-wrap gap-1.5">
                        {localExcludedDirs.map((dir) => (
                          <span
                            key={dir}
                            className="inline-flex items-center gap-1.5 px-2 py-1 text-[10.5px] font-mono text-text-secondary"
                            style={{
                              backgroundColor:
                                'color-mix(in srgb, var(--aurora-editor-foreground) 6%, transparent)',
                              border:
                                '1px solid color-mix(in srgb, var(--aurora-common-border) 60%, transparent)',
                              borderRadius: 4,
                            }}
                          >
                            <Folder className="h-2.5 w-2.5 text-text-disabled" />
                            {dir}
                            <button
                              type="button"
                              onClick={() => removeExcludedDir(dir)}
                              className="text-text-disabled hover:text-danger"
                            >
                              <X className="h-2.5 w-2.5" />
                            </button>
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </FormRow>
              </>
            ) : (
              <FormBlock>
                <p className="text-[11.5px] text-text-secondary">
                  {!rootPath
                    ? 'Open a workspace to configure workspace-specific exclusions.'
                    : 'Index this workspace first to configure exclusions.'}
                </p>
              </FormBlock>
            )}

            {semanticDataDir && (
              <FormRowLast
                label="Index storage location"
                hint="Each workspace keeps its own embeddings index."
                align="top"
              >
                <div className="flex w-[300px] gap-1.5">
                  <code
                    className="flex-1 truncate px-2.5 py-1.5 text-[10.5px] font-mono text-text-secondary"
                    style={{
                      backgroundColor:
                        'color-mix(in srgb, var(--aurora-editor-background) 65%, var(--aurora-common-secondary) 35%)',
                      border:
                        '1px solid color-mix(in srgb, var(--aurora-common-border) 70%, transparent)',
                      borderRadius: 6,
                    }}
                    title={semanticDataDir}
                  >
                    {semanticDataDir}
                  </code>
                  <IconButton
                    ariaLabel="Open in file explorer"
                    title="Open in file explorer"
                    onClick={() => {
                      import('@tauri-apps/plugin-shell').then(({ open }) => {
                        open(semanticDataDir);
                      });
                    }}
                    variant="secondary"
                  >
                    <ExternalLink className="h-3 w-3" />
                  </IconButton>
                </div>
              </FormRowLast>
            )}
          </>
        ) : (
          <FormBlock divided={false}>
            <p className="text-[11.5px] text-text-secondary">
              Click "Show" above to expand exclusions, file size, and storage settings.
            </p>
          </FormBlock>
        )}
      </Section>

      {/* ============================================================ */}
      {/* Directory picker modal                                        */}
      {/* ============================================================ */}
      {showDirPicker && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50">
          <div
            className="flex max-h-[500px] w-[420px] flex-col shadow-xl"
            style={{
              ...settingsCardStyle,
              borderRadius: 8,
            }}
          >
            <div
              className="flex items-center justify-between px-3 py-2.5"
              style={{ borderBottom: `1px solid ${settingsRowDividerColor}` }}
            >
              <span className="text-[12px] font-semibold uppercase tracking-[0.12em] text-text-secondary">
                Select directories to exclude
              </span>
              <IconButton
                ariaLabel="Close"
                onClick={() => setShowDirPicker(false)}
                variant="secondary"
              >
                <X className="h-3.5 w-3.5" />
              </IconButton>
            </div>
            <div className="max-h-[350px] flex-1 overflow-y-auto p-2">
              {workspaceDirs.length === 0 ? (
                <p className="py-4 text-center text-[11px] text-text-disabled">
                  No directories found
                </p>
              ) : (
                <DirectoryTree
                  entries={workspaceDirs}
                  expandedDirs={expandedDirs}
                  dirChildren={dirChildren}
                  excludedDirs={localExcludedDirs}
                  rootPath={rootPath || ''}
                  onToggle={toggleDirExpand}
                  onSelect={addExcludedDir}
                />
              )}
            </div>
            <div
              className="flex justify-end px-3 py-2"
              style={{ borderTop: `1px solid ${settingsRowDividerColor}` }}
            >
              <ActionButton variant="primary" onClick={() => setShowDirPicker(false)}>
                Done
              </ActionButton>
            </div>
          </div>
        </div>
      )}

      {/* ============================================================ */}
      {/* All indexed workspaces                                        */}
      {/* ============================================================ */}
      {allIndexes.length > 0 && (
        <Section
          title="All Indexed Workspaces"
          description="Every workspace Aurora has indexed on this machine."
          badge={
            <span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-text-disabled">
              {allIndexes.length}
            </span>
          }
        >
          <div className="max-h-44 overflow-y-auto">
            {allIndexes.map((idx, index) => (
              <div
                key={idx.id}
                className="flex items-center justify-between gap-3 px-4 py-2.5"
                style={
                  index < allIndexes.length - 1
                    ? { borderBottom: `1px solid ${settingsRowDividerColor}` }
                    : undefined
                }
              >
                <div className="flex min-w-0 items-center gap-2">
                  {getStatusIcon(idx.status)}
                  <span className="truncate text-[11.5px] font-medium text-text-primary">
                    {idx.workspaceName}
                  </span>
                </div>
                <span className="shrink-0 font-mono text-[10.5px] text-text-disabled">
                  {idx.documentCount} files
                </span>
              </div>
            ))}
          </div>
        </Section>
      )}
    </div>
  );
};

// Directory Tree Component for the picker
interface DirectoryTreeProps {
  entries: FileEntry[];
  expandedDirs: Set<string>;
  dirChildren: Record<string, FileEntry[]>;
  excludedDirs: string[];
  rootPath: string;
  onToggle: (path: string) => void;
  onSelect: (path: string) => void;
  depth?: number;
}

const DirectoryTree: React.FC<DirectoryTreeProps> = ({
  entries,
  expandedDirs,
  dirChildren,
  excludedDirs,
  rootPath,
  onToggle,
  onSelect,
  depth = 0,
}) => {
  return (
    <div className={clsx(depth > 0 && 'ml-3 border-l border-border/30 pl-1')}>
      {entries.map((entry) => {
        const isExpanded = expandedDirs.has(entry.path);
        const children = dirChildren[entry.path] || [];
        const relativePath = entry.path.replace(rootPath, '').replace(/^[/\\]+/, '');
        const isExcluded = excludedDirs.includes(relativePath);

        return (
          <div key={entry.path}>
            <div
              className={clsx(
                'flex items-center gap-1 py-1 px-1 rounded text-[11px] cursor-pointer transition-colors',
                isExcluded 
                  ? 'bg-primary/10 text-primary' 
                  : 'text-text-secondary hover:bg-input hover:text-text-primary'
              )}
            >
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onToggle(entry.path);
                }}
                className="p-0.5 hover:bg-input rounded"
              >
                {isExpanded ? (
                  <ChevronDown className="w-3 h-3" />
                ) : (
                  <ChevronRight className="w-3 h-3" />
                )}
              </button>
              <Folder className={clsx('w-3.5 h-3.5', isExcluded ? 'text-primary' : 'text-text-disabled')} />
              <span 
                className="flex-1 truncate"
                onClick={() => !isExcluded && onSelect(entry.path)}
              >
                {entry.name}
              </span>
              {isExcluded ? (
                <span className="text-[9px] px-1 py-0.5 rounded bg-primary/20 text-primary">Excluded</span>
              ) : (
                <button
                  onClick={() => onSelect(entry.path)}
                  className="opacity-0 group-hover:opacity-100 p-0.5 text-[9px] text-primary hover:bg-primary/10 rounded transition-opacity"
                >
                  <Plus className="w-3 h-3" />
                </button>
              )}
            </div>
            {isExpanded && children.length > 0 && (
              <DirectoryTree
                entries={children}
                expandedDirs={expandedDirs}
                dirChildren={dirChildren}
                excludedDirs={excludedDirs}
                rootPath={rootPath}
                onToggle={onToggle}
                onSelect={onSelect}
                depth={depth + 1}
              />
            )}
          </div>
        );
      })}
    </div>
  );
};

