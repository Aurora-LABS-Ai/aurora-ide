/**
 * Multi-File Service
 * Enables Cursor-style parallel file reading with full context awareness
 */
import { toolRegistry } from "../tools/registry";
import type { ToolCallResult } from "../tools/types";

export interface FileReadResult {
  content?: string;
  error?: string;
  lines?: number;
  path: string;
  size?: number;
  success: boolean;
}

export interface MultiFileReadResult {
  errorCount: number;
  files: Map<string, FileReadResult>;
  successCount: number;
  totalTime: number;
}

export class MultiFileService {
  /**
   * Get file context for multiple files
   * Returns a formatted string with all file contents
   */
  public async getFilesContext(paths: string[]): Promise<string> {
    const result = await this.readFiles(paths);
    const contextParts: string[] = [];

    for (const [path, fileResult] of result.files) {
      if (fileResult.success && fileResult.content) {
        contextParts.push(`
=== File: ${path} (${fileResult.lines || 0} lines) ===
${fileResult.content}
`);
      } else {
        contextParts.push(`
=== File: ${path} (ERROR) ===
Error: ${fileResult.error || 'Unknown error'}
`);
      }
    }

    return contextParts.join('\n');
  }

  /**
   * Read multiple files in parallel (Cursor-style)
   * This is the key feature for 10x speed boost
   */
  public async readFiles(paths: string[]): Promise<MultiFileReadResult> {
    const startTime = Date.now();
    const results = new Map<string, FileReadResult>();

    console.log(`[MultiFileService] Reading ${paths.length} files in parallel...`);

    // Execute all reads in parallel
    const promises = paths.map(async (path) => {
      try {
        const toolCall = {
          id: `read-${path}-${Date.now()}`,
          type: 'function' as const,
          function: {
            name: 'file_read',
            arguments: JSON.stringify({ path }),
          },
        };

        const result: ToolCallResult = await toolRegistry.executeToolCall(toolCall);

        // Parse result
        const parsedResult = this.parseToolResult(result.content);

        const fileResult: FileReadResult = {
          path,
          success: parsedResult.success || false,
          content: parsedResult.content,
          error: parsedResult.error,
          lines: parsedResult.lines,
          size: parsedResult.content?.length,
        };

        results.set(path, fileResult);
      } catch (error) {
        const fileResult: FileReadResult = {
          path,
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
        results.set(path, fileResult);
      }
    });

    // Wait for all reads to complete
    await Promise.all(promises);

    const totalTime = Date.now() - startTime;
    const successCount = Array.from(results.values()).filter((r) => r.success).length;
    const errorCount = results.size - successCount;

    console.log(
      `[MultiFileService] Completed ${results.size} reads in ${totalTime}ms (${successCount} success, ${errorCount} errors)`
    );

    return {
      files: results,
      successCount,
      errorCount,
      totalTime,
    };
  }

  /**
   * Read all files in a directory with a pattern
   */
  public async readFilesInDirectory(
    directory: string,
    pattern?: string
  ): Promise<MultiFileReadResult> {
    // First, list files in directory
    const listToolCall = {
      id: `list-${directory}-${Date.now()}`,
      type: 'function' as const,
      function: {
        name: 'workspace_list_files',
        arguments: JSON.stringify({ path: directory, filter: pattern }),
      },
    };

    const listResult = await toolRegistry.executeToolCall(listToolCall);
    const parsedList = this.parseToolResult(listResult.content);

    if (!parsedList.success || !parsedList.files) {
      return {
        files: new Map(),
        successCount: 0,
        errorCount: 0,
        totalTime: 0,
      };
    }

    // Read all files in parallel
    const filePaths = parsedList.files.map((file: any) => file.path);
    return this.readFiles(filePaths);
  }

  /**
   * Read files and return as a simple map of path -> content
   */
  public async readFilesSimple(paths: string[]): Promise<Map<string, string>> {
    const result = await this.readFiles(paths);
    const contentMap = new Map<string, string>();

    for (const [path, fileResult] of result.files) {
      if (fileResult.success && fileResult.content) {
        contentMap.set(path, fileResult.content);
      }
    }

    return contentMap;
  }

  /**
   * Read related files based on import statements
   * Useful for understanding component dependencies
   */
  public async readRelatedFiles(
    mainFilePath: string,
    _maxDepth: number = 1
  ): Promise<MultiFileReadResult> {
    // TODO: Implement import parsing and recursive reading
    // For now, just read the main file
    return this.readFiles([mainFilePath]);
  }

  /**
   * Parse tool result (handles both JSON string and plain string)
   */
  private parseToolResult(content: string): any {
    try {
      return JSON.parse(content);
    } catch {
      // If not JSON, return as-is
      return { success: true, content };
    }
  }
}

// Singleton instance
export const multiFileService = new MultiFileService();
