import {
  auroraInvoke as invoke,
  auroraListen as listen,
  type AuroraUnlistenFn as UnlistenFn,
} from "../lib/runtime";

import type {
  ExecutionProviderDetails,
  GpuFeatures,
  IndexProgress,
  SearchMode,
  SemanticGraphSearchResult,
  SemanticIndex,
  SemanticSearchResult,
  SemanticSettings,
} from "../types/database";

/**
 * Model info returned from validation
 */
export interface ModelInfo {
  executionProvider: ExecutionProviderDetails | null;
  hasConfig: boolean;
  hasTokenizer: boolean;
  name: string;
  path: string;
  sizeBytes: number;
}

/**
 * Semantic search service for code indexing and search
 */
class SemanticService {
  private initialized = false;
  private progressListeners: Map<string, (progress: IndexProgress) => void> = new Map();
  private unlistenComplete: UnlistenFn | null = null;
  private unlistenError: UnlistenFn | null = null;
  private unlistenProgress: UnlistenFn | null = null;

  constructor() {
    // Don't setup listeners in constructor - do it lazily
  }

  /**
   * Cancel ongoing indexing
   */
  public async cancelIndexing(indexId: string): Promise<void> {
    this.progressListeners.delete(indexId);
    await invoke('cancel_semantic_indexing', { indexId });
  }

  /**
   * Delete a semantic index (also removes index files)
   */
  public async deleteIndex(id: string, workspacePath: string): Promise<void> {
    await invoke('delete_semantic_index', { id, workspacePath });
  }

  /**
   * Cleanup event listeners
   */
  public dispose() {
    this.unlistenProgress?.();
    this.unlistenComplete?.();
    this.unlistenError?.();
    this.initialized = false;
  }

  // ============================================================
  // HELPERS
  // ============================================================

  /**
   * Format bytes to human readable string
   */
  public formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  // ============================================================
  // INDEX MANAGEMENT
  // ============================================================

  /**
   * Get all semantic indexes
   */
  public async getAllIndexes(): Promise<SemanticIndex[]> {
    try {
      return await invoke<SemanticIndex[]>('get_all_semantic_indexes');
    } catch (error) {
      console.error('Failed to get semantic indexes:', error);
      return [];
    }
  }

  /**
   * Get available GPU features (what was compiled into the binary)
   */
  public async getAvailableGpuFeatures(): Promise<GpuFeatures> {
    try {
      return await invoke<GpuFeatures>('get_available_gpu_features');
    } catch (error) {
      console.error('Failed to get GPU features:', error);
      return { cuda: false, tensorrt: false, directml: false, coreml: false };
    }
  }

  /**
   * Get execution provider info for a model
   */
  public async getExecutionProviderInfo(modelPath: string): Promise<ExecutionProviderDetails | null> {
    try {
      return await invoke<ExecutionProviderDetails>('get_execution_provider_info', { modelPath });
    } catch (error) {
      console.error('Failed to get execution provider info:', error);
      return null;
    }
  }

  /**
   * Get a semantic index by ID
   */
  public async getIndex(id: string): Promise<SemanticIndex | null> {
    try {
      return await invoke<SemanticIndex | null>('get_semantic_index', { id });
    } catch (error) {
      console.error('Failed to get semantic index:', error);
      return null;
    }
  }

  /**
   * Get a semantic index by workspace path
   */
  public async getIndexByPath(workspacePath: string): Promise<SemanticIndex | null> {
    try {
      return await invoke<SemanticIndex | null>('get_semantic_index_by_path', { workspacePath });
    } catch (error) {
      console.error('Failed to get semantic index by path:', error);
      return null;
    }
  }

  /**
   * Get index directory path for a specific workspace path.
   */
  public async getIndexPath(workspacePath: string): Promise<string> {
    return await invoke<string>('get_semantic_index_path', { workspaceId: workspacePath });
  }

  /**
   * Get model info if valid
   */
  public async getModelInfo(path: string): Promise<ModelInfo | null> {
    try {
      return await invoke<ModelInfo | null>('get_semantic_model_info', { path });
    } catch (error) {
      console.error('Failed to get model info:', error);
      return null;
    }
  }

  /**
   * Get the workspace-local semantic index directory.
   */
  public async getSemanticDataDirectory(workspacePath?: string | null): Promise<string> {
    return await invoke<string>('get_semantic_data_directory', {
      workspacePath: workspacePath || null,
    });
  }

  // ============================================================
  // SETTINGS
  // ============================================================

  /**
   * Get semantic settings
   */
  public async getSettings(): Promise<SemanticSettings> {
    try {
      return await invoke<SemanticSettings>('get_semantic_settings');
    } catch (error) {
      console.error('Failed to get semantic settings:', error);
      // Return defaults
      return {
        modelPath: null,
        enabled: true,
        autoIndex: false,
        autoReindexInterval: null,
        ignoredPatterns: ['*.min.js', '*.min.css', '*.map', '*.lock'],
        ignoredDirectories: ['node_modules', 'target', '.git', 'dist', 'build', '.next', '__pycache__', '.venv'],
        excludedFiles: [],
        excludedDirectories: [],
        maxFileSize: 524288,
        searchMode: 'hybrid',
        lexicalWeight: 0.4,
        semanticWeight: 0.6,
        updatedAt: '',
      };
    }
  }

  /**
   * Get status color for UI
   */
  public getStatusColor(status: string): string {
    switch (status) {
      case 'ready':
        return 'text-green-400';
      case 'indexing':
        return 'text-blue-400';
      case 'pending':
        return 'text-yellow-400';
      case 'error':
        return 'text-red-400';
      default:
        return 'text-text-secondary';
    }
  }

  /**
   * Get status icon name
   */
  public getStatusIcon(status: string): 'check-circle' | 'loader' | 'clock' | 'alert-circle' {
    switch (status) {
      case 'ready':
        return 'check-circle';
      case 'indexing':
        return 'loader';
      case 'pending':
        return 'clock';
      case 'error':
        return 'alert-circle';
      default:
        return 'clock';
    }
  }

  /**
   * Initialize event listeners (call once when app starts)
   */
  public async init() {
    if (this.initialized) return;
    this.initialized = true;
    await this.setupEventListeners();
  }

  /**
   * Check if indexing is in progress
   */
  public async isIndexing(): Promise<boolean> {
    try {
      return await invoke<boolean>('is_semantic_indexing');
    } catch {
      return false;
    }
  }

  /**
   * Save semantic settings
   */
  public async saveSettings(settings: SemanticSettings): Promise<void> {
    await invoke('save_semantic_settings', { settings });
  }

  // ============================================================
  // SEARCH
  // ============================================================

  /**
   * Search options interface matching Aurora Semantic native capabilities.
   */
  // Note: This is defined here for the service, the tool executor has its own copy

  /**
   * Search code chunks using the workspace-local semantic index.
   */
  public async search(
    workspacePath: string,
    query: string,
    options?: {
      limit?: number;
      mode?: SearchMode;
      minScore?: number;
      // Filters from aurora-semantic SearchFilter
      languages?: string[];
      chunkTypes?: string[];
      pathPatterns?: string[];
      symbolNames?: string[];
      directories?: string[];
      excludeDirectories?: string[];
    }
  ): Promise<SemanticSearchResult[]> {
    return await invoke<SemanticSearchResult[]>('semantic_search', {
      workspacePath,
      query,
      limit: options?.limit ?? 20,
      mode: options?.mode,
      minScore: options?.minScore,
      languages: options?.languages,
      chunkTypes: options?.chunkTypes,
      pathPatterns: options?.pathPatterns,
      symbolNames: options?.symbolNames,
      directories: options?.directories,
      excludeDirectories: options?.excludeDirectories,
    });
  }

  /**
   * Search graph nodes directly for symbols, files, routes, and tools.
   */
  public async graphSearch(
    workspacePath: string,
    query: string,
    options?: {
      includeContext?: boolean;
      labels?: string[];
      limit?: number;
      minScore?: number;
      mode?: SearchMode;
      pathPatterns?: string[];
    }
  ): Promise<SemanticGraphSearchResult[]> {
    return await invoke<SemanticGraphSearchResult[]>('semantic_graph_search', {
      workspacePath,
      query,
      limit: options?.limit ?? 20,
      mode: options?.mode,
      minScore: options?.minScore,
      labels: options?.labels,
      pathPatterns: options?.pathPatterns,
      includeContext: options?.includeContext,
    });
  }

  /**
   * Set model path
   */
  public async setModelPath(path: string | null): Promise<void> {
    await invoke('set_semantic_model_path', { path });
  }

  // ============================================================
  // INDEXING
  // ============================================================

  /**
   * Start indexing a workspace
   * @param workspacePath Path to the workspace
   * @param workspaceName Display name for the workspace
   * @param onProgress Callback for progress updates
   * @returns The index ID
   */
  public async startIndexing(
    workspacePath: string,
    workspaceName: string,
    onProgress?: (progress: IndexProgress) => void
  ): Promise<string> {
    const indexId = await invoke<string>('start_semantic_indexing', {
      workspacePath,
      workspaceName,
    });

    // Register progress listener
    if (onProgress) {
      this.progressListeners.set(indexId, onProgress);
    }

    return indexId;
  }

  /**
   * Update index status
   */
  public async updateIndexStatus(id: string, status: string, errorMessage?: string): Promise<void> {
    await invoke('update_semantic_index_status', { id, status, errorMessage });
  }

  /**
   * Update workspace-specific exclusions
   */
  public async updateWorkspaceExclusions(
    workspacePath: string,
    excludedFiles: string[],
    excludedDirectories: string[]
  ): Promise<void> {
    await invoke('update_workspace_exclusions', {
      workspacePath,
      excludedFiles,
      excludedDirectories,
    });
  }

  /**
   * Validate model directory
   */
  public async validateModelPath(path: string): Promise<boolean> {
    try {
      return await invoke<boolean>('validate_semantic_model_path', { path });
    } catch (error) {
      console.error('Failed to validate model path:', error);
      return false;
    }
  }

  /**
   * Setup Tauri event listeners for indexing progress
   */
  private async setupEventListeners() {
    // Listen for progress events
    this.unlistenProgress = await listen<IndexProgress>('semantic-index-progress', (event) => {
      const progress = event.payload;
      
      // Call local listener if registered
      const listener = this.progressListeners.get(progress.workspaceId);
      if (listener) {
        listener(progress);
      }
      
      // Call global handler (for store updates)
      if (globalProgressHandler) {
        globalProgressHandler(progress);
      }
    });

    // Listen for completion events
    this.unlistenComplete = await listen<{ workspaceId: string; documentCount: number; chunkCount: number; totalBytes: number }>(
      'semantic-index-complete',
      (event) => {
        const data = event.payload;
        this.progressListeners.delete(data.workspaceId);
        
        // Call global handler
        if (globalCompleteHandler) {
          globalCompleteHandler(data);
        }
      }
    );

    // Listen for error events
    this.unlistenError = await listen<{ workspaceId: string; error: string }>(
      'semantic-index-error',
      (event) => {
        const data = event.payload;
        this.progressListeners.delete(data.workspaceId);
        
        // Call global handler
        if (globalErrorHandler) {
          globalErrorHandler(data);
        }
      }
    );
  }
}

type CompleteHandler = (data: { workspaceId: string; documentCount: number; chunkCount: number; totalBytes: number }) => void;

type ErrorHandler = (data: { workspaceId: string; error: string }) => void;

// Global event handlers that can be set by the store
type ProgressHandler = (progress: IndexProgress) => void;

/**
 * Set global event handlers (called by the store)
 */
export function setSemanticEventHandlers(
  onProgress: ProgressHandler | null,
  onComplete: CompleteHandler | null,
  onError: ErrorHandler | null
) {
  globalProgressHandler = onProgress;
  globalCompleteHandler = onComplete;
  globalErrorHandler = onError;
}

let globalCompleteHandler: CompleteHandler | null = null;
let globalErrorHandler: ErrorHandler | null = null;
let globalProgressHandler: ProgressHandler | null = null;

// Export singleton instance
export const semanticService = new SemanticService();
