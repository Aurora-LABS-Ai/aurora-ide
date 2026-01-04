/**
 * Search Tool Executors
 * Handles execution of search tools including aurora_search (semantic search)
 * Supports aurora-semantic v1.2.1 with full filtering capabilities
 */
import { semanticService } from "../../services/semantic";
import { useSemanticStore } from "../../store/useSemanticStore";
import { useWorkspaceStore } from "../../store/useWorkspaceStore";
import type { SearchMode } from "../../types/database";
import { toolRegistry } from "../registry";

/**
 * Search options interface matching aurora-semantic v1.2.1 capabilities
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
  
  // Filter parameters
  const languages = args.languages as string[] | undefined;
  const chunkTypes = args.chunkTypes as string[] | undefined;
  const pathPatterns = args.pathPatterns as string[] | undefined;
  const symbolNames = args.symbolNames as string[] | undefined;
  const directories = args.directories as string[] | undefined;
  const excludeDirectories = args.excludeDirectories as string[] | undefined;
  
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
      error: error instanceof Error ? error.message : 'Search failed',
    });
  }
}

/**
 * Register all search tool executors
 */
export const registerSearchExecutors = (): void => {
  toolRegistry.registerExecutor('aurora_search', executeAuroraSearch);
};
