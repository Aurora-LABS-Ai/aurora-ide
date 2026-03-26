/**
 * THEME ARCHITECTURE NOTICE:
 * Uses centralized theme system with CSS variables.
 * See: src/types/theme.ts for TypeScript interfaces
 */

import React, { useEffect, useState, useCallback, useRef } from 'react';
import {
  Database,
  FolderOpen,
  Search,
  RefreshCw,
  Trash2,
  CheckCircle,
  AlertCircle,
  Clock,
  Loader2,
  HardDrive,
  Cpu,
  FileCode,
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
import { TogglePill } from '../ui/TogglePill';
import { SettingsSelect } from '../ui/SettingsSelect';
import { useSemanticStore } from '../../store/useSemanticStore';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { open } from '@tauri-apps/plugin-dialog';
import { semanticService } from '../../services/semantic';
import { readDirectory, type FileEntry } from '../../lib/tauri';
import { settingsCardStyle, settingsSubtlePanelStyle } from './settings-shared';

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
    // Load semantic data directory path
    semanticService.getSemanticDataDirectory().then(setSemanticDataDir).catch(() => {});
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
      <div className="flex items-center justify-center h-40">
        <Loader2 className="w-5 h-5 text-primary animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Enable/Disable Toggle */}
      <div className="rounded-[20px] p-4" style={settingsCardStyle}>
        <div className="flex items-center justify-between">
          <div className="flex min-w-0 items-center gap-2">
            <Database className="w-4 h-4 text-primary" />
            <div className="min-w-0">
              <h3 className="text-xs font-medium text-text-primary">Semantic Search</h3>
              <p className="text-[9px] text-text-disabled">AI-powered code search using embeddings</p>
            </div>
          </div>
          <TogglePill
            checked={!!settings?.enabled}
            onChange={(next) => saveSettings({ enabled: next })}
            ariaLabel="Toggle semantic search"
            variant="primary"
            size="sm"
          />
        </div>
      </div>

      {/* Model Configuration */}
      <div className="rounded-[20px] p-4" style={settingsCardStyle}>
        <div className="flex items-center gap-2 mb-3">
          <Cpu className="w-4 h-4 text-primary" />
          <h3 className="text-xs font-medium text-text-primary">Embedding Model</h3>
        </div>

        <div className="space-y-2">
          <div>
            <label className="text-[10px] text-text-secondary block mb-1">
              ONNX Model Directory
            </label>
            <div className="flex gap-1">
              <input
                type="text"
                value={localModelPath}
                onChange={(e) => handleModelPathChange(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && modelPathDirty && handleSaveModelPath()}
                placeholder="Path to model directory (optional)"
                className={clsx(
                  "flex-1 bg-input border rounded px-2 py-1.5 text-xs text-text-primary placeholder:text-text-disabled font-mono focus:outline-none focus:border-primary",
                  modelPathDirty ? "border-warning" : "border-input-border"
                )}
              />
              <button
                onClick={handleBrowseModel}
                className="px-2 py-1.5 rounded bg-input border border-input-border text-text-secondary hover:text-text-primary hover:bg-input-hover transition-colors"
                title="Browse for model directory"
              >
                <FolderOpen className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={handleSaveModelPath}
                disabled={!modelPathDirty || savingModelPath}
                className={clsx(
                  "px-2 py-1.5 rounded border transition-colors",
                  modelPathDirty
                    ? "bg-primary border-primary text-primary-foreground hover:bg-primary/80"
                    : "bg-input border-input-border text-text-disabled cursor-not-allowed"
                )}
                title={modelPathDirty ? "Save model path" : "No changes to save"}
              >
                {savingModelPath ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Save className="w-3.5 h-3.5" />
                )}
              </button>
            </div>
            {modelPathDirty && (
              <p className="text-[9px] text-warning mt-1">Unsaved changes - click Save or press Enter</p>
            )}
          </div>

          {/* Model Status - simple indicator, actual validation happens on Index */}
          {localModelPath && !modelPathDirty && (
            <div className="flex items-center gap-2 rounded-[16px] px-3 py-2 text-[10px] text-text-secondary" style={settingsSubtlePanelStyle}>
              <Database className="w-3.5 h-3.5" />
              <span>Model path set - will be loaded when indexing</span>
            </div>
          )}

          {/* No model info */}
          {!localModelPath && (
            <div
              className="flex items-start gap-2 rounded-[16px] px-3 py-2 text-[10px] text-info"
              style={{
                ...settingsSubtlePanelStyle,
                backgroundColor: 'color-mix(in srgb, var(--aurora-common-info) 10%, var(--aurora-common-muted))',
                border: '1px solid color-mix(in srgb, var(--aurora-common-info) 18%, transparent)',
              }}
            >
              <Info className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
              <div>
                <p className="font-medium">No model configured</p>
                <p className="text-text-disabled mt-0.5">
                  Without an ONNX model, search uses fast hash-based embeddings (lexical-focused).
                  For semantic search, download a model like jina-embeddings-v2-base-code.
                </p>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Current Workspace Index */}
      <div className="rounded-[20px] p-4" style={settingsCardStyle}>
        <div className="flex items-center justify-between mb-3">
          <div className="flex min-w-0 items-center gap-2">
            <FileCode className="w-4 h-4 text-primary" />
            <h3 className="text-xs font-medium text-text-primary">Current Workspace Index</h3>
          </div>
          {currentIndex && (
            <button
              onClick={handleDeleteIndex}
              className="p-1 rounded text-text-disabled hover:text-danger hover:bg-danger/10 transition-colors"
              title="Delete index"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        {!rootPath ? (
          <p className="text-[10px] text-text-disabled">No workspace open</p>
        ) : currentIndex ? (
          <div className="space-y-2">
            {/* Status */}
            <div className="flex items-center gap-2">
              {getStatusIcon(currentIndex.status)}
              <span className="text-xs text-text-primary capitalize">{currentIndex.status}</span>
              {currentIndex.errorMessage && (
                <span className="text-[10px] text-danger">({currentIndex.errorMessage})</span>
              )}
            </div>

            {/* Stats */}
            {currentIndex.status === 'ready' && (
              <div className="grid grid-cols-3 gap-2 text-[10px]">
                <div className="rounded-[16px] px-3 py-2" style={settingsSubtlePanelStyle}>
                  <p className="text-text-disabled">Documents</p>
                  <p className="text-text-primary font-medium">{currentIndex.documentCount.toLocaleString()}</p>
                </div>
                <div className="rounded-[16px] px-3 py-2" style={settingsSubtlePanelStyle}>
                  <p className="text-text-disabled">Chunks</p>
                  <p className="text-text-primary font-medium">{currentIndex.chunkCount.toLocaleString()}</p>
                </div>
                <div className="rounded-[16px] px-3 py-2" style={settingsSubtlePanelStyle}>
                  <p className="text-text-disabled">Size</p>
                  <p className="text-text-primary font-medium">{formatBytes(currentIndex.totalBytes)}</p>
                </div>
              </div>
            )}

            {/* Progress */}
            {isIndexing && (
              <div className="space-y-1">
                <div className="flex items-center justify-between text-[10px]">
                  <span className="text-text-secondary capitalize">
                    {indexProgress?.phase || 'Starting'}...
                  </span>
                  <span className="text-text-disabled">
                    {indexProgress ? `${indexProgress.percentage.toFixed(0)}%` : '0%'}
                  </span>
                </div>
                <div className="h-1.5 bg-input rounded-full overflow-hidden">
                  <div
                    className="h-full bg-primary transition-all duration-300"
                    style={{ width: `${indexProgress?.percentage || 0}%` }}
                  />
                </div>
                {indexProgress?.currentFile && (
                  <p className="text-[9px] text-text-disabled truncate">
                    {indexProgress.currentFile}
                  </p>
                )}
              </div>
            )}

            {/* Actions */}
            <div className="flex gap-2 pt-1">
              {isIndexing ? (
                <button
                  onClick={() => cancelIndexing(currentIndex.id)}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-danger bg-danger/10 hover:bg-danger/20 rounded transition-colors"
                >
                  <AlertCircle className="w-3.5 h-3.5" />
                  Cancel
                </button>
              ) : (
                <button
                  onClick={handleStartIndexing}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-primary-foreground bg-primary hover:bg-primary/80 rounded transition-colors"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  Re-index
                </button>
              )}
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            <p className="text-[10px] text-text-disabled">This workspace has not been indexed yet.</p>
            <button
              onClick={handleStartIndexing}
              disabled={isIndexing}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-primary-foreground bg-primary hover:bg-primary/80 rounded transition-colors disabled:opacity-50"
            >
              {isIndexing ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Database className="w-3.5 h-3.5" />
              )}
              Index Workspace
            </button>
          </div>
        )}
      </div>

      {/* Search Settings */}
      <div className="rounded-[20px] p-4" style={settingsCardStyle}>
        <div className="flex items-center gap-2 mb-3">
          <Search className="w-4 h-4 text-primary" />
          <h3 className="text-xs font-medium text-text-primary">Search Settings</h3>
        </div>

        <div className="space-y-3">
          {/* Search Mode */}
          <div>
            <label className="text-[10px] text-text-secondary block mb-1">Search Mode</label>
            <SettingsSelect
              ariaLabel="Select semantic search mode"
              options={[
                { label: 'Hybrid (Recommended)', value: 'hybrid' },
                { label: 'Lexical Only (Keywords)', value: 'lexical' },
                { label: 'Semantic Only (Meaning)', value: 'semantic' },
              ]}
              onChange={(nextValue) => saveSettings({ searchMode: String(nextValue) as 'lexical' | 'semantic' | 'hybrid' })}
              value={settings?.searchMode || 'hybrid'}
            />
          </div>

          {/* Weights (only for hybrid mode) */}
          {settings?.searchMode === 'hybrid' && (
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-[10px] text-text-secondary block mb-1">
                  Lexical Weight ({(localLexicalWeight * 100).toFixed(0)}%)
                </label>
                <input
                  type="range"
                  min="0"
                  max="100"
                  value={localLexicalWeight * 100}
                  onChange={(e) => handleWeightChange(parseInt(e.target.value) / 100)}
                  className="w-full accent-primary"
                />
              </div>
              <div>
                <label className="text-[10px] text-text-secondary block mb-1">
                  Semantic Weight ({(localSemanticWeight * 100).toFixed(0)}%)
                </label>
                <input
                  type="range"
                  min="0"
                  max="100"
                  value={localSemanticWeight * 100}
                  onChange={(e) => handleWeightChange(1 - parseInt(e.target.value) / 100)}
                  className="w-full accent-primary"
                />
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Advanced Settings (Collapsible) */}
      <div className="overflow-hidden rounded-[20px]" style={settingsCardStyle}>
        <button
          onClick={() => setShowAdvanced(!showAdvanced)}
          className="w-full flex items-center justify-between p-4 transition-colors hover:bg-input/30"
        >
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <HardDrive className="w-4 h-4 text-primary" />
            <h3 className="truncate text-xs font-medium text-text-primary">Advanced Settings</h3>
          </div>
          <ChevronDown
            className={clsx(
              'ml-3 h-4 w-4 shrink-0 text-text-disabled transition-transform',
              showAdvanced && 'rotate-180',
            )}
          />
        </button>

        {showAdvanced && (
          <div className="space-y-3 border-t border-border px-4 pb-4 pt-4">
            {/* Auto Index */}
            <div className="flex items-center justify-between">
              <div>
                <p className="text-[10px] text-text-secondary">Auto-index on workspace open</p>
                <p className="text-[9px] text-text-disabled">Automatically index new workspaces</p>
              </div>
              <TogglePill
                checked={!!settings?.autoIndex}
                onChange={(next) => saveSettings({ autoIndex: next })}
                ariaLabel="Toggle auto-index on workspace open"
                variant="primary"
                size="sm"
              />
            </div>

            {/* Max File Size */}
            <div>
              <label className="text-[10px] text-text-secondary block mb-1">
                Max File Size ({formatBytes(settings?.maxFileSize || 1048576)})
              </label>
              <SettingsSelect
                ariaLabel="Select semantic max file size"
                options={[
                  { label: '512 KB', value: 524288 },
                  { label: '1 MB', value: 1048576 },
                  { label: '2 MB', value: 2097152 },
                  { label: '5 MB', value: 5242880 },
                ]}
                onChange={(nextValue) => saveSettings({ maxFileSize: Number(nextValue) })}
                value={settings?.maxFileSize || 1048576}
              />
            </div>

            {/* Ignored Directories */}
            <div>
              <label className="text-[10px] text-text-secondary block mb-1">Ignored Directories</label>
              <input
                type="text"
                value={localIgnoredDirs}
                onChange={(e) => {
                  setLocalIgnoredDirs(e.target.value);
                  debouncedTextSave('ignoredDirectories', e.target.value);
                }}
                onBlur={(e) => handleTextBlur('ignoredDirectories', e.target.value)}
                placeholder="node_modules, target, dist"
                className="w-full bg-input border border-input-border rounded px-2 py-1.5 text-xs text-text-primary placeholder:text-text-disabled font-mono focus:outline-none focus:border-primary"
              />
            </div>

            {/* Ignored Patterns */}
            <div>
              <label className="text-[10px] text-text-secondary block mb-1">Ignored File Patterns</label>
              <input
                type="text"
                value={localIgnoredPatterns}
                onChange={(e) => {
                  setLocalIgnoredPatterns(e.target.value);
                  debouncedTextSave('ignoredPatterns', e.target.value);
                }}
                onBlur={(e) => handleTextBlur('ignoredPatterns', e.target.value)}
                placeholder="*.min.js, *.map, *.lock"
                className="w-full bg-input border border-input-border rounded px-2 py-1.5 text-xs text-text-primary placeholder:text-text-disabled font-mono focus:outline-none focus:border-primary"
              />
            </div>

            {/* Workspace-Specific Exclusions Section */}
            {rootPath && currentIndex ? (
              <div className="pt-2 border-t border-border/50">
                <p className="text-[10px] text-text-secondary font-medium mb-2">Workspace-Specific Exclusions</p>
                <p className="text-[9px] text-text-disabled mb-2">
                  Exclude specific files or directories for this workspace only. Re-index after changes.
                </p>
                
                {/* Excluded Files */}
                <div className="mb-2">
                  <label className="text-[10px] text-text-secondary block mb-1">Excluded Files</label>
                  <textarea
                    value={localExcludedFiles}
                    onChange={(e) => {
                      setLocalExcludedFiles(e.target.value);
                      const excludedFiles = e.target.value.split('\n').map(s => s.trim()).filter(Boolean);
                      saveWorkspaceExclusions(excludedFiles, localExcludedDirs);
                    }}
                    onBlur={handleExclusionBlur}
                    placeholder="src/generated/types.ts&#10;src/proto/generated.rs&#10;config/secrets.json"
                    rows={3}
                    className="w-full bg-input border border-input-border rounded px-2 py-1.5 text-xs text-text-primary placeholder:text-text-disabled font-mono focus:outline-none focus:border-primary resize-none"
                  />
                  <p className="text-[9px] text-text-disabled mt-0.5">One file path per line</p>
                </div>

                {/* Excluded Directories */}
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label className="text-[10px] text-text-secondary">Excluded Directories</label>
                    <button
                      onClick={openDirPicker}
                      disabled={!rootPath}
                      className="flex items-center gap-1 px-1.5 py-0.5 text-[9px] font-medium text-primary bg-primary/10 hover:bg-primary/20 rounded transition-colors disabled:opacity-50"
                    >
                      <Plus className="w-2.5 h-2.5" />
                      Browse
                    </button>
                  </div>
                  
                  {/* Selected directories as tags */}
                  {localExcludedDirs.length > 0 && (
                    <div className="flex flex-wrap gap-1 mb-2">
                      {localExcludedDirs.map((dir) => (
                        <span
                          key={dir}
                          className="flex items-center gap-1 rounded-full border px-2 py-1 text-[10px] font-mono text-text-secondary"
                          style={settingsSubtlePanelStyle}
                        >
                          <Folder className="w-2.5 h-2.5 text-text-disabled" />
                          {dir}
                          <button
                            onClick={() => removeExcludedDir(dir)}
                            className="text-text-disabled hover:text-danger transition-colors"
                          >
                            <X className="w-2.5 h-2.5" />
                          </button>
                        </span>
                      ))}
                    </div>
                  )}

                  {/* Directory Picker Modal */}
                  {showDirPicker && (
                    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[60]">
                      <div className="flex max-h-[500px] w-[420px] flex-col rounded-[22px] shadow-xl" style={settingsCardStyle}>
                        <div className="flex items-center justify-between px-3 py-2 border-b border-border">
                          <span className="text-xs font-medium text-text-primary">Select Directories to Exclude</span>
                          <button
                            onClick={() => setShowDirPicker(false)}
                            className="p-1 rounded text-text-secondary hover:text-text-primary hover:bg-input"
                          >
                            <X className="w-3.5 h-3.5" />
                          </button>
                        </div>
                        <div className="flex-1 overflow-y-auto p-2 max-h-[350px]">
                          {workspaceDirs.length === 0 ? (
                            <p className="text-[10px] text-text-disabled text-center py-4">No directories found</p>
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
                        <div className="px-3 py-2 border-t border-border flex justify-end">
                          <button
                            onClick={() => setShowDirPicker(false)}
                            className="px-3 py-1 text-xs font-medium text-primary-foreground bg-primary hover:bg-primary/80 rounded transition-colors"
                          >
                            Done
                          </button>
                        </div>
                      </div>
                    </div>
                  )}

                  <p className="text-[9px] text-text-disabled">Click "Browse" to select directories from your workspace</p>
                </div>
              </div>
            ) : (
              <div className="pt-2 border-t border-border/50">
                <p className="text-[10px] text-text-disabled">
                  {!rootPath 
                    ? "Open a workspace to configure workspace-specific exclusions." 
                    : "Index this workspace first to configure workspace-specific exclusions."}
                </p>
              </div>
            )}

            {/* Storage Location */}
            {semanticDataDir && (
              <div>
                <label className="text-[10px] text-text-secondary block mb-1">Index Storage Location</label>
                <div className="flex items-center gap-1">
                  <code
                    className="flex-1 rounded-[16px] px-3 py-2 text-[10px] text-text-disabled font-mono truncate"
                    style={settingsSubtlePanelStyle}
                  >
                    {semanticDataDir}
                  </code>
                  <button
                    onClick={() => {
                      // Open in file explorer
                      import('@tauri-apps/plugin-shell').then(({ open }) => {
                        open(semanticDataDir);
                      });
                    }}
                    className="p-1.5 rounded bg-input border border-input-border text-text-secondary hover:text-text-primary hover:bg-input-hover transition-colors"
                    title="Open in file explorer"
                  >
                    <ExternalLink className="w-3 h-3" />
                  </button>
                </div>
                <p className="text-[9px] text-text-disabled mt-1">
                  Index files are stored per-workspace in user app data, not inside workspaces.
                </p>
              </div>
            )}
          </div>
        )}
      </div>

      {/* All Indexed Workspaces */}
      {allIndexes.length > 0 && (
        <div className="rounded-[20px] p-4" style={settingsCardStyle}>
          <h3 className="text-xs font-medium text-text-primary mb-2">All Indexed Workspaces</h3>
          <div className="space-y-1 max-h-32 overflow-y-auto">
            {allIndexes.map((idx) => (
              <div
                key={idx.id}
                className="flex items-center justify-between rounded-[16px] px-3 py-2 text-[10px]"
                style={settingsSubtlePanelStyle}
              >
                <div className="flex items-center gap-2 min-w-0">
                  {getStatusIcon(idx.status)}
                  <span className="text-text-primary truncate">{idx.workspaceName}</span>
                </div>
                <span className="text-text-disabled flex-shrink-0">
                  {idx.documentCount} files
                </span>
              </div>
            ))}
          </div>
        </div>
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

