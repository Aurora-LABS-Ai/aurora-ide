/**
 * Search Tool Executors
 * Handles execution of search tools including aurora_search.
 * Supports native Aurora Semantic chunk and graph search.
 */
import { semanticService } from "../../services/semantic";
import { auroraWebSearch } from "../../lib/tauri";
import { useSemanticStore } from "../../store/useSemanticStore";
import { useWorkspaceStore } from "../../store/useWorkspaceStore";
import type { SearchMode } from "../../types/database";
import { toolRegistry } from "../registry";

type AuroraSearchTarget = 'chunks' | 'symbols';

/**
 * Search options interface matching Aurora Semantic native capabilities.
 */
export interface AuroraSearchOptions {
    chunkTypes?: string[];
    directories?: string[];
    excludeDirectories?: string[];

    // Filters
    languages?: string[];
  limit?: number;
  minScore?: number;
  mode?: SearchMode;
    pathPatterns?: string[];
    symbolNames?: string[];
}

export interface AuroraSearchResult {
  error?: string;
  filters?: {
    languages?: string[];
    chunkTypes?: string[];
    pathPatterns?: string[];
    symbolNames?: string[];
    directories?: string[];
    excludeDirectories?: string[];
  };
  indexStatus: string;
  message?: string;
  query: string;
  results: Array<{
    filePath: string;
    relativePath: string;
    fileName: string;
    startLine: number;
    endLine: number;
    chunkType: string;
    symbolName: string | null;
    content: string;
    score: number;
    matchType: string;
  }>;
  searchMode: string;
  success: boolean;
  target?: AuroraSearchTarget;
  totalResults: number;
}

export interface AuroraGraphSearchResult {
  error?: string;
  indexStatus: string;
  message?: string;
  query: string;
  results: Array<{
    id: string;
    label: string;
    name: string;
    qualifiedName: string | null;
    path: string | null;
    startLine: number | null;
    endLine: number | null;
    score: number;
    matchType: string;
    relationshipCount: number;
    relatedNodes: Array<{
      id: string;
      label: string;
      name: string;
      path: string | null;
      startLine: number | null;
      endLine: number | null;
    }>;
  }>;
  searchMode: string;
  success: boolean;
  target: 'symbols';
  totalResults: number;
}

/**
 * Execute aurora_search - Semantic code search with full filtering
 * Returns JSON string for tool registry compatibility
 */
export async function executeAuroraSearch(args: Record<string, unknown>): Promise<string> {
  const query = args.query as string;
  const limit = Math.min((args.limit as number) || 10, 50);
  const mode = (args.mode as SearchMode) || 'hybrid';
  const minScore = (args.minScore as number) || 0.1;
  const target = ((args.target as AuroraSearchTarget | undefined) || 'chunks');
  
  // Filter parameters
  const languages = args.languages as string[] | undefined;
  const chunkTypes = args.chunkTypes as string[] | undefined;
  const pathPatterns = args.pathPatterns as string[] | undefined;
  const symbolNames = args.symbolNames as string[] | undefined;
  const directories = args.directories as string[] | undefined;
  const excludeDirectories = args.excludeDirectories as string[] | undefined;
  const labels = args.labels as string[] | undefined;
  
  if (!query) {
    return JSON.stringify({
      success: false,
      query: '',
      results: [],
      totalResults: 0,
      searchMode: 'unknown',
      indexStatus: 'error',
      error: 'Query parameter is required',
    });
  }
  
  // Get current workspace
  const workspacePath = useWorkspaceStore.getState().rootPath;
  
  if (!workspacePath) {
    return JSON.stringify({
      success: false,
      query,
      results: [],
      totalResults: 0,
      searchMode: 'unknown',
      indexStatus: 'no_workspace',
      error: 'No workspace is currently open. Please open a folder first.',
    });
  }

  // Check if semantic search is enabled
  const settings = useSemanticStore.getState().settings;
  
  if (!settings?.enabled) {
    return JSON.stringify({
      success: false,
      query,
      results: [],
      totalResults: 0,
      searchMode: 'disabled',
      indexStatus: 'disabled',
      message: 'Semantic search is disabled. Please enable it in Settings > Semantic Search.',
      error: 'Semantic search is disabled',
    });
  }

  if (!settings.modelPath) {
    return JSON.stringify({
      success: false,
      query,
      results: [],
      totalResults: 0,
      searchMode: mode,
      target,
      indexStatus: 'model_missing',
      message: 'No embedding model is configured. Set the Qwen3 ONNX model path in Settings > Semantic Search, then index the workspace.',
      error: 'Semantic model path is not configured',
    });
  }

  // Check if workspace is indexed
  const currentIndex = useSemanticStore.getState().currentIndex;
  
  if (!currentIndex || currentIndex.status !== 'ready') {
    const status = currentIndex?.status || 'not_indexed';
    return JSON.stringify({
      success: false,
      query,
      results: [],
      totalResults: 0,
      searchMode: mode,
      indexStatus: status,
      message: status === 'indexing' 
        ? 'Workspace is currently being indexed. Please wait for indexing to complete.'
        : 'This workspace has not been indexed yet. Please go to Settings > Semantic Search and click "Index Workspace".',
      error: `Workspace index status: ${status}`,
    });
  }

  try {
    if (target === 'symbols') {
      const graphResults = await semanticService.graphSearch(workspacePath, query, {
        limit,
        mode,
        minScore,
        labels,
        pathPatterns,
        includeContext: true,
      });

      const transformedResults = graphResults.map((result) => ({
        id: result.node.id,
        label: result.node.label,
        name: result.node.name,
        qualifiedName: result.node.qualifiedName,
        path: result.node.path,
        startLine: result.node.startLine,
        endLine: result.node.endLine,
        score: result.score,
        matchType: result.matchType,
        relationshipCount: result.relationships.length,
        relatedNodes: result.relatedNodes.slice(0, 10).map((node) => ({
          id: node.id,
          label: node.label,
          name: node.name,
          path: node.path,
          startLine: node.startLine,
          endLine: node.endLine,
        })),
      }));

      const response: AuroraGraphSearchResult = {
        success: true,
        query,
        target: 'symbols',
        results: transformedResults,
        totalResults: transformedResults.length,
        searchMode: mode,
        indexStatus: 'ready',
        message: transformedResults.length > 0
          ? `Found ${transformedResults.length} graph node${transformedResults.length !== 1 ? 's' : ''}`
          : 'No graph nodes found for this query',
      };

      return JSON.stringify(response);
    }

    // Build search options with filters
    const searchOptions: AuroraSearchOptions = {
      limit,
      mode,
      minScore,
    };
    
    // Add filters if provided
    if (languages?.length) searchOptions.languages = languages;
    if (chunkTypes?.length) searchOptions.chunkTypes = chunkTypes;
    if (pathPatterns?.length) searchOptions.pathPatterns = pathPatterns;
    if (symbolNames?.length) searchOptions.symbolNames = symbolNames;
    if (directories?.length) searchOptions.directories = directories;
    if (excludeDirectories?.length) searchOptions.excludeDirectories = excludeDirectories;

    // Execute semantic search with filters
    const searchResults = await semanticService.search(
      workspacePath,
      query,
      searchOptions
    );

    // Transform results for display
    const transformedResults = searchResults.map(result => ({
      filePath: result.filePath,
      relativePath: result.relativePath,
      fileName: result.relativePath.split(/[/\\]/).pop() || result.relativePath,
      startLine: result.startLine,
      endLine: result.endLine,
      chunkType: result.chunkType,
      symbolName: result.symbolName,
      content: result.content,
      score: result.score,
      matchType: result.matchType,
    }));

    // Build response with filter info
    const response: AuroraSearchResult = {
      success: true,
      query,
      target: 'chunks',
      results: transformedResults,
      totalResults: transformedResults.length,
      searchMode: mode,
      indexStatus: 'ready',
      message: transformedResults.length > 0 
        ? `Found ${transformedResults.length} result${transformedResults.length !== 1 ? 's' : ''}`
        : 'No results found for this query',
    };

    // Include active filters in response for transparency
    const activeFilters: AuroraSearchResult['filters'] = {};
    if (languages?.length) activeFilters.languages = languages;
    if (chunkTypes?.length) activeFilters.chunkTypes = chunkTypes;
    if (pathPatterns?.length) activeFilters.pathPatterns = pathPatterns;
    if (symbolNames?.length) activeFilters.symbolNames = symbolNames;
    if (directories?.length) activeFilters.directories = directories;
    if (excludeDirectories?.length) activeFilters.excludeDirectories = excludeDirectories;
    
    if (Object.keys(activeFilters).length > 0) {
      response.filters = activeFilters;
    }

    return JSON.stringify(response);
  } catch (error) {
    console.error('Aurora search error:', error);
    return JSON.stringify({
      success: false,
      query,
      results: [],
      totalResults: 0,
      searchMode: mode,
      indexStatus: currentIndex?.status || 'unknown',
      target,
      error: error instanceof Error ? error.message : 'Search failed',
    });
  }
}

/**
 * Execute auroro_websearch - Web search + page fetch
 */
export async function executeAuroroWebSearch(args: Record<string, unknown>): Promise<string> {
  try {
    const response = await auroraWebSearch({
      action: args.action as string | undefined,
      query: args.query as string | undefined,
      url: args.url as string | undefined,
      numResults: args.numResults as number | undefined,
      region: args.region as string | undefined,
      safeSearch: args.safeSearch as string | undefined,
    });

    return JSON.stringify(response);
  } catch (error) {
    return JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : 'Web search failed',
    });
  }
}

/**
 * Register all search tool executors
 */
export const registerSearchExecutors = (): void => {
  toolRegistry.registerExecutor('aurora_search', executeAuroraSearch);
  toolRegistry.registerExecutor('auroro_websearch', executeAuroroWebSearch);
};

