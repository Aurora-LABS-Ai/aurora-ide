/**
 * Search Tools - Definitions
 * Web search and page-fetch tooling. Codebase exploration is handled by
 * `grep` plus the file/workspace tools — Aurora no longer ships a semantic
 * indexer.
 */
import type { ToolDefinition } from "../types";

// ============================================
// AURORA WEB SEARCH TOOL (Aurora WebSearch SDK)
// ============================================
export const auroroWebSearchTool: ToolDefinition = {
  type: 'function',
  nativeRustOwned: true,
  function: {
    name: 'auroro_websearch',
    description: `**NATIVE WEB SEARCH + PAGE FETCH** powered by Aurora WebSearch SDK (DuckDuckGo backend).

Use this tool to search the web or fetch a page and extract its content.

**MODES:**
- search: Provide a query to search the web. Returns titles, URLs, snippets.
- fetch: Provide a url to fetch and extract clean text content from a web page.

**REQUIRED:**
- search: query
- fetch: url

**RESPONSE FORMAT:**
- search: { query, results: [{ title, url, snippet, position }], count, has_more }
- fetch: { url, title, content, description, word_count, links }

**EXAMPLES:**
- auroro_websearch(action="search", query="rust async runtimes", numResults=5)
- auroro_websearch(action="fetch", url="https://rust-lang.org")`,
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['search', 'fetch'],
          description: 'Action to perform. Use "search" for web search or "fetch" to extract a web page.',
        },
        query: {
          type: 'string',
          description: 'Search query for web search (required for search action).',
        },
        url: {
          type: 'string',
          description: 'URL to fetch content from (required for fetch action).',
        },
        numResults: {
          type: 'number',
          description: 'Number of results for web search (1-50). Default: 10.',
          default: 10,
        },
        region: {
          type: 'string',
          description: 'Search region (e.g., "us-en", "uk-en").',
        },
        safeSearch: {
          type: 'string',
          enum: ['OFF', 'MODERATE', 'STRICT'],
          description: 'Safe search mode. Default: MODERATE.',
        },
      },
      required: [],
    },
  },
};

// Export all search tools as an array
export const searchTools: ToolDefinition[] = [
  auroroWebSearchTool,
];
