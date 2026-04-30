/**
 * Search Tools - Definitions
 * Advanced search tools powered by the native Aurora Semantic workspace index.
 */
import type { ToolDefinition } from "../types";

// ============================================
// AURORA SEARCH TOOL (Semantic Search)
// ============================================
export const auroraSearchTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'aurora_search',
    description: `**NATIVE AURORA CODEBASE SEARCH** - Search the current workspace's .aurora/index using Qwen3 ONNX embeddings, lexical ranking, and the Aurora Semantic code graph.

Use this tool when you need codebase context from an indexed workspace. It can return source chunks or graph nodes for symbols/files/routes/tools.

**TARGETS:**
- "chunks" (default): returns code chunks with file paths, line ranges, symbol names, content, and scores
- "symbols": searches the graph directly and returns functions, classes, files, routes, tools, and their direct relationships

**SEARCH MODES:**
- "hybrid" (default): Combines lexical (keywords) + semantic (meaning) - best for most queries
- "lexical": Fast keyword-based search - good for exact terms
- "semantic": Pure AI embedding search - good for conceptual queries

**FILTERS (optional):**
- languages: Filter by programming language (rust, python, typescript, javascript, go, java, c, cpp)
- chunkTypes: Filter by code structure (function, class, struct, enum, interface, module, imports, constant, typedef, implementation)
- pathPatterns: Glob patterns to filter file paths (e.g., "**/src/**", "*.ts")
- symbolNames: Filter by symbol/function names (partial match)
- directories: Only search in these directories
- excludeDirectories: Exclude these directories from search
- labels: For target="symbols", restrict graph nodes (function, method, class, file, route, tool, namespace, struct, enum, trait)

**WHEN TO USE:**
- Finding implementations: "where is user authentication handled"
- Understanding architecture: "how does the routing system work"  
- Locating features: "find the payment processing logic"
- Finding specific symbols: target="symbols", labels=["function"], query="database connection"
- Finding files/routes/tools: target="symbols", labels=["file", "route", "tool"]
- Finding specific types: target="chunks", query="database", chunkTypes=["class", "struct"]
- Language-specific: query="error handling", languages=["typescript"]

**WHEN NOT TO USE:**
- Exact string search (use grep instead)
- Known file paths (use file_read instead)

**EXAMPLES:**
- aurora_search(query="where are database connections managed")
- aurora_search(query="dashboard", target="symbols", labels=["file", "function"])
- aurora_search(query="authentication logic", mode="semantic", limit=20)
- aurora_search(query="API handlers", languages=["typescript"], chunkTypes=["function"])
- aurora_search(query="state management", pathPatterns=["**/store/**", "**/state/**"])
- aurora_search(query="utility functions", directories=["src/utils", "src/helpers"])`,
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Natural language query describing what you are looking for. Be specific and descriptive for best results.',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results to return. Default: 10, Max: 50',
          default: 10,
        },
        mode: {
          type: 'string',
          enum: ['hybrid', 'lexical', 'semantic'],
          description: 'Search mode: "hybrid" (default, combines both), "lexical" (keywords only), "semantic" (AI meaning only)',
          default: 'hybrid',
        },
        target: {
          type: 'string',
          enum: ['chunks', 'symbols'],
          description: 'Result target. Use "chunks" for source snippets/content, "symbols" for graph nodes such as functions, files, routes, and tools.',
          default: 'chunks',
        },
        languages: {
          type: 'array',
          items: { type: 'string' },
          description: 'Filter by programming languages: rust, python, typescript, javascript, go, java, c, cpp',
        },
        chunkTypes: {
          type: 'array',
          items: { type: 'string' },
          description: 'Filter by code structure types: function, class, struct, enum, interface, module, imports, constant, typedef, implementation, block, comment',
        },
        pathPatterns: {
          type: 'array',
          items: { type: 'string' },
          description: 'Glob patterns to filter file paths (e.g., "**/src/**", "*.ts", "**/components/**")',
        },
        symbolNames: {
          type: 'array',
          items: { type: 'string' },
          description: 'Filter by symbol/function names (partial match, case-insensitive)',
        },
        directories: {
          type: 'array',
          items: { type: 'string' },
          description: 'Only search within these directories (relative paths)',
        },
        excludeDirectories: {
          type: 'array',
          items: { type: 'string' },
          description: 'Exclude these directories from search (relative paths)',
        },
        labels: {
          type: 'array',
          items: { type: 'string' },
          description: 'For target="symbols": graph node labels to include, such as function, method, class, file, route, tool, namespace, struct, enum, trait',
        },
        minScore: {
          type: 'number',
          description: 'Minimum relevance score threshold (0.0 to 1.0). Default: 0.1',
          default: 0.1,
        },
      },
      required: ['query'],
    },
  },
};

// ============================================
// AURORA WEB SEARCH TOOL (Aurora WebSearch SDK)
// ============================================
export const auroroWebSearchTool: ToolDefinition = {
  type: 'function',
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
  auroraSearchTool,
  auroroWebSearchTool,
];
