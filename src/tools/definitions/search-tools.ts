/**
 * Search Tools - Definitions
 * Advanced search tools including semantic search powered by Aurora Semantic Engine v1.2.1
 */
import type { ToolDefinition } from "../types";

// ============================================
// AURORA SEARCH TOOL (Semantic Search)
// ============================================
export const auroraSearchTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'aurora_search',
    description: `**POWERFUL SEMANTIC CODE SEARCH** - Find code by meaning, not just text patterns.

This tool uses AI embeddings to understand code semantically. It finds related code even when exact keywords don't match.

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

**WHEN TO USE:**
- Finding implementations: "where is user authentication handled"
- Understanding architecture: "how does the routing system work"  
- Locating features: "find the payment processing logic"
- Finding specific types: query="database", chunkTypes=["class", "struct"]
- Language-specific: query="error handling", languages=["typescript"]

**WHEN NOT TO USE:**
- Exact string search (use grep instead)
- Known file paths (use file_read instead)

**EXAMPLES:**
- aurora_search(query="where are database connections managed")
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

// Export all search tools as an array
export const searchTools: ToolDefinition[] = [
  auroraSearchTool,
];
