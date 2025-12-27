/**
 * Operation Logging System
 * Tracks all file system operations and enforces safety rules
 * Inspired by Shai CLI's operation logging
 */

export const FsOperationType = {
  Read: 'read',
  Write: 'write',
  Edit: 'edit',
  Delete: 'delete',
  Create: 'create',
} as const;

export type FsOperationType = typeof FsOperationType[keyof typeof FsOperationType];

export interface FsOperation {
  type: FsOperationType;
  path: string;
  timestamp: number;
  metadata?: Record<string, any>;
}

export interface OperationSummary {
  totalOperations: number;
  readCount: number;
  writeCount: number;
  editCount: number;
  createCount: number;
  deleteCount: number;
  uniqueFilesRead: number;
  uniqueFilesModified: number;
}

export class FsOperationLog {
  private operations: FsOperation[] = [];
  private readFiles: Set<string> = new Set();
  private modifiedFiles: Set<string> = new Set();

  /**
   * Log a file operation
   */
  logOperation(
    type: FsOperationType,
    path: string,
    metadata?: Record<string, any>
  ): void {
    const operation: FsOperation = {
      type,
      path,
      timestamp: Date.now(),
      metadata,
    };

    this.operations.push(operation);

    // Track reads separately for validation
    if (type === FsOperationType.Read) {
      this.readFiles.add(path);
    }

    // Track modifications
    if (
      type === FsOperationType.Write ||
      type === FsOperationType.Edit ||
      type === FsOperationType.Delete
    ) {
      this.modifiedFiles.add(path);
    }

    console.log(`[OperationLog] ${type.toUpperCase()} - ${path}`, metadata);
  }

  /**
   * Check if a file has been read
   */
  hasBeenRead(path: string): boolean {
    return this.readFiles.has(path);
  }

  /**
   * Validate that a file can be edited (must have been read first)
   */
  validateEditPermission(path: string): void {
    if (!this.hasBeenRead(path)) {
      throw new Error(
        `Cannot edit file '${path}': The file must be read first using the read tool before it can be edited. This is a safety measure to prevent accidental overwrites.`
      );
    }
  }

  /**
   * Get all operations for a specific file
   */
  getFileOperations(path: string): FsOperation[] {
    return this.operations.filter((op) => op.path === path);
  }

  /**
   * Get all operations
   */
  getAllOperations(): FsOperation[] {
    return [...this.operations];
  }

  /**
   * Get summary statistics
   */
  getSummary(): OperationSummary {
    return {
      totalOperations: this.operations.length,
      readCount: this.operations.filter((op) => op.type === FsOperationType.Read).length,
      writeCount: this.operations.filter((op) => op.type === FsOperationType.Write).length,
      editCount: this.operations.filter((op) => op.type === FsOperationType.Edit).length,
      createCount: this.operations.filter((op) => op.type === FsOperationType.Create).length,
      deleteCount: this.operations.filter((op) => op.type === FsOperationType.Delete).length,
      uniqueFilesRead: this.readFiles.size,
      uniqueFilesModified: this.modifiedFiles.size,
    };
  }

  /**
   * Clear the log (useful for starting fresh conversation)
   */
  clear(): void {
    this.operations = [];
    this.readFiles.clear();
    this.modifiedFiles.clear();
    console.log('[OperationLog] Cleared all operations');
  }

  /**
   * Get read files count
   */
  getReadFilesCount(): number {
    return this.readFiles.size;
  }

  /**
   * Get modified files count
   */
  getModifiedFilesCount(): number {
    return this.modifiedFiles.size;
  }

  /**
   * Export log for debugging
   */
  exportLog(): string {
    return JSON.stringify(
      {
        summary: this.getSummary(),
        operations: this.operations,
      },
      null,
      2
    );
  }
}

// Singleton instance
export const operationLog = new FsOperationLog();
