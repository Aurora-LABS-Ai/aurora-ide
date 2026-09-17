/**
 * Search Tools - Definitions
 * Web search and page-fetch tooling. Codebase exploration is handled by
 * `grep` plus the file/workspace tools — Aurora no longer ships a semantic
 * indexer.
 */
import type { ToolDefinition } from "@/apps/agent/tools/types";

// ============================================
// AURORA WEB SEARCH + PAGE FETCH
// ============================================
/**
 * Display and approval metadata only.
 *
 * `nativeRustOwned` means the schema the model actually sees is the Rust
 * registry's (`tools/file_workspace_search/auroro_websearch.rs`), and this
 * definition is filtered out of the roster by `buildAvailableTools`. Keep the
 * two in step anyway — this is what a reader opens first.
 */
export const auroroWebSearchTool: ToolDefinition = {
  type: 'function',
  nativeRustOwned: true,
  function: {
    name: 'auroro_websearch',
    description: `Search the web, find research papers or images, or read one web page.

- search: give a query, get ranked results with titles, URLs and summaries.
- source="scholar": search scholarly catalogues for papers and abstracts.
- source="images": find existing pictures on Wikimedia Commons, up to 10 results,
  with thumbnail URLs, originals, source pages and attribution. Link the source
  page and keep the creator and license when provided. Region and safeSearch
  apply only to web searches. Image metadata is not visual inspection.
- fetch: give a url, get the page as Markdown. Headings, lists, tables, code
  blocks and links survive; navigation, scripts and footers are removed. Plain
  text, JSON and source files come back as they are, and a GitHub file page is
  read as the file itself.

A long page arrives one window at a time. When a result says hasMore, call
again with the same url and offset set to nextOffset to read on.

This reads pages, it does not operate them. For a page that needs a click, a
sign-in, or JavaScript to render, use browser tools when available. Otherwise
try another source and explain what could not be read.

Examples:
- auroro_websearch(action="search", query="rust async runtimes", numResults=5)
- auroro_websearch(action="fetch", url="https://doc.rust-lang.org/book/")
- auroro_websearch(action="fetch", url="https://doc.rust-lang.org/book/", offset=30000)`,
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['search', 'fetch'],
          description: 'Defaults to "fetch" when a url is given, "search" otherwise.',
        },
        query: {
          type: 'string',
          description: 'Search query. Required for action="search".',
        },
        url: {
          type: 'string',
          description: 'Page to read. Required for action="fetch".',
        },
        numResults: {
          type: 'number',
          description: 'Results to return, 1-25. Search only. Default: 10.',
          default: 10,
        },
        source: {
          type: 'string',
          enum: ['web', 'scholar', 'images'],
          default: 'web',
          description: 'Search catalogue: open web, research papers, or Wikimedia Commons images.',
        },
        region: {
          type: 'string',
          description: 'Search region, e.g. "us-en", "uk-en", "de-de".',
        },
        safeSearch: {
          type: 'string',
          enum: ['OFF', 'MODERATE', 'STRICT'],
          description: 'Safe search mode. Default: MODERATE.',
        },
        maxChars: {
          type: 'number',
          description:
            'Characters of page text to return. Fetch only. Default 30000, maximum 120000.',
        },
        offset: {
          type: 'number',
          description:
            'Character to start reading at. Pass the previous result\'s nextOffset to continue a long page. Fetch only.',
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
