/**
 * Search Tool Executors
 * Handles execution of web-search tooling. Codebase exploration is now driven
 * exclusively by `grep` plus the file/workspace tools — Aurora no longer ships
 * a semantic indexer.
 */
import { auroraWebSearch } from "../../lib/tauri";
import { toolRegistry } from "../registry";

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
  toolRegistry.registerExecutor('auroro_websearch', executeAuroroWebSearch);
};
