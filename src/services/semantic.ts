import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type {
  SemanticIndex,
  SemanticSettings,
  SemanticSearchResult,
  IndexProgress,
  SearchMode,
  ExecutionProviderDetails,
  GpuFeatures,
} from '../types/database';

/**
 * Model info returned from validation
 */
export interface ModelInfo {
  path: string;
  name: string;
  sizeBytes: number;
  hasTokenizer: boolean;
  hasConfig: boolean;
  executionProvider: ExecutionProviderDetails | null;
}

// Global event handlers that can be set by the store
type ProgressHandler = (progress: IndexProgress) => void;
type CompleteHandler = (data: { workspaceId: string; documentCount: number; chunkCount: number; totalBytes: number }) => void;
type ErrorHandler = (data: { workspaceId: string; error: string }) => void;

let globalProgressHandler: ProgressHandler | null = null;
let globalCompleteHandler: CompleteHandler | null = null;
let globalErrorHandler: ErrorHandler | null = null;

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

/**
 * Semantic search service for code indexing and search
 */
class SemanticService {
  private progressListeners: Map<string, (progress: IndexProgress) => void> = new Map();
  private unlistenProgress: UnlistenFn | null = null;
  private unlistenComplete: UnlistenFn | null = null;
  private unlistenError: UnlistenFn | null = null;
  private initialized = false;

  constructor() {
    // Don't setup listeners in constructor - do it lazily
  }

  /**
   * Initialize event listeners (call once when app starts)
   */
  async init() {
    if (this.initialized) return;
    this.initialized = true;
    await this.setupEventListeners();
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

  /**
   * Cleanup event listeners
   */
  dispose() {
    this.unlistenProgress?.();
    this.unlistenComplete?.();
    this.unlistenError?.();
    this.initialized = false;
  }

  // ============================================================
  // INDEX MANAGEMENT
  // ============================================================

  /**
   * Get all semantic indexes
   */
  async getAllIndexes(): Promise<SemanticIndex[]> {
    try {
      return await invoke<SemanticIndex[]>('get_all_semantic_indexes');
    } catch (error) {
      console.error('Failed to get semantic indexes:', error);
      return [];
    }
  }

  /**
   * Get a semantic index by ID
   */
  async getIndex(id: string): Promise<SemanticIndex | null> {
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
  async getIndexByPath(workspacePath: string): Promise<SemanticIndex | null> {
    try {
      return await invoke<SemanticIndex | null>('get_semantic_index_by_path', { workspacePath });
    } catch (error) {
      console.error('Failed to get semantic index by path:', error);
      return null;
    }
  }

  /**
   * Delete a semantic index (also removes index files)
   */
  async deleteIndex(id: string, workspacePath: string): Promise<void> {
    await invoke('delete_semantic_index', { id, workspacePath });
  }

  /**
   * Update index status
   */
  async updateIndexStatus(id: string, status: string, errorMessage?: string): Promise<void> {
    await invoke('update_semantic_index_status', { id, status, errorMessage });
  }

  /**
   * Update workspace-specific exclusions
   */
  async updateWorkspaceExclusions(
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

  // ============================================================
  // SETTINGS
  // ============================================================

  /**
   * Get semantic settings
   */
  async getSettings(): Promise<SemanticSettings> {
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
        maxFileSize: 1048576,
        searchMode: 'hybrid',
        lexicalWeight: 0.4,
        semanticWeight: 0.6,
        updatedAt: '',
      };
    }
  }

  /**
   * Save semantic settings
   */
  async saveSettings(settings: SemanticSettings): Promise<void> {
    await invoke('save_semantic_settings', { settings });
  }

  /**
   * Set model path
   */
  async setModelPath(path: string | null): Promise<void> {
    await invoke('set_semantic_model_path', { path });
  }

  /**
   * Validate model directory
   */
  async validateModelPath(path: string): Promise<boolean> {
    try {
      return await invoke<boolean>('validate_semantic_model_path', { path });
    } catch (error) {
      console.error('Failed to validate model path:', error);
      return false;
    }
  }

  /**
   * Get model info if valid
   */
  async getModelInfo(path: string): Promise<ModelInfo | null> {
    try {
      return await invoke<ModelInfo | null>('get_semantic_model_info', { path });
    } catch (error) {
      console.error('Failed to get model info:', error);
      return null;
    }
  }

  /**
   * Get execution provider info for a model
   */
  async getExecutionProviderInfo(modelPath: string): Promise<ExecutionProviderDetails | null> {
    try {
      return await invoke<ExecutionProviderDetails>('get_execution_provider_info', { modelPath });
    } catch (error) {
      console.error('Failed to get execution provider info:', error);
      return null;
    }
  }

  /**
   * Get available GPU features (what was compiled into the binary)
   */
  async getAvailableGpuFeatures(): Promise<GpuFeatures> {
    try {
      return await invoke<GpuFeatures>('get_available_gpu_features');
    } catch (error) {
      console.error('Failed to get GPU features:', error);
      return { cuda: false, tensorrt: false, directml: false, coreml: false };
    }
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
  async startIndexing(
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
   * Cancel ongoing indexing
   */
  async cancelIndexing(indexId: string): Promise<void> {
    this.progressListeners.delete(indexId);
    await invoke('cancel_semantic_indexing', { indexId });
  }

  /**
   * Check if indexing is in progress
   */
  async isIndexing(): Promise<boolean> {
    try {
      return await invoke<boolean>('is_semantic_indexing');
    } catch (error) {
      return false;
    }
  }

  /**
   * Get the user-level semantic data directory
   * This is where all semantic index data is stored (not in workspace .aurora folder)
   */
  async getSemanticDataDirectory(): Promise<string> {
    return await invoke<string>('get_semantic_data_directory');
  }

  /**
   * Get index directory path for a specific workspace UUID
   */
  async getIndexPath(workspaceId: string): Promise<string> {
    return await invoke<string>('get_semantic_index_path', { workspaceId });
  }

  // ============================================================
  // SEARCH
  // ============================================================

  /**
   * Search options interface matching aurora-semantic v1.2.1 capabilities
   */
  // Note: This is defined here for the service, the tool executor has its own copy

  /**
   * Search using semantic index with full filtering support
   * Supports aurora-semantic v1.2.1 SearchQuery and SearchFilter features
   */
  async search(
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
    try {
      return await invoke<SemanticSearchResult[]>('semantic_search', {
        workspacePath,
        query,
        limit: options?.limit ?? 20,
        mode: options?.mode,
        minScore: options?.minScore,
        // Pass filters to backend
        languages: options?.languages,
        chunkTypes: options?.chunkTypes,
        pathPatterns: options?.pathPatterns,
        symbolNames: options?.symbolNames,
        directories: options?.directories,
        excludeDirectories: options?.excludeDirectories,
      });
    } catch (error) {
      console.error('Semantic search failed:', error);
      return [];
    }
  }

  // ============================================================
  // HELPERS
  // ============================================================

  /**
   * Format bytes to human readable string
   */
  formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  /**
   * Get status color for UI
   */
  getStatusColor(status: string): string {
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
  getStatusIcon(status: string): 'check-circle' | 'loader' | 'clock' | 'alert-circle' {
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
}

// Export singleton instance
export const semanticService = new SemanticService();

