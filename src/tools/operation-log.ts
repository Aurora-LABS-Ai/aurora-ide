/**
 * Operation Logging System
 * Tracks all file system operations and enforces safety rules
 * Inspired by Shai CLI's operation logging
 */
export interface FsOperation {
  metadata?: Record<string, any>;
  path: string;
  timestamp: number;
  type: FsOperationType;
}

export interface OperationSummary {
  createCount: number;
  deleteCount: number;
  editCount: number;
  readCount: number;
  totalOperations: number;
  uniqueFilesModified: number;
  uniqueFilesRead: number;
  writeCount: number;
}

export class FsOperationLog {
  private modifiedFiles: Set<string> = new Set();
  private operations: FsOperation[] = [];
  private readFiles: Set<string> = new Set();

  /**
   * Clear the log (useful for starting fresh conversation)
   */
  public clear(): void {
    this.operations = [];
    this.readFiles.clear();
    this.modifiedFiles.clear();
    console.log('[OperationLog] Cleared all operations');
  }

  /**
   * Export log for debugging
   */
  public exportLog(): string {
    return JSON.stringify(
      {
        summary: this.getSummary(),
        operations: this.operations,
      },
      null,
      2
    );
  }

  /**
   * Get all operations
   */
  public getAllOperations(): FsOperation[] {
    return [...this.operations];
  }

  /**
   * Get all operations for a specific file
   */
  public getFileOperations(path: string): FsOperation[] {
    return this.operations.filter((op) => op.path === path);
  }

  /**
   * Get modified files count
   */
  public getModifiedFilesCount(): number {
    return this.modifiedFiles.size;
  }

  /**
   * Get read files count
   */
  public getReadFilesCount(): number {
    return this.readFiles.size;
  }

  /**
   * Get summary statistics
   */
  public getSummary(): OperationSummary {
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
   * Check if a file has been read
   */
  public hasBeenRead(path: string): boolean {
    return this.readFiles.has(path);
  }

  /**
   * Log a file operation
   */
  public logOperation(
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
   * Validate that a file can be edited (must have been read first)
   */
  public validateEditPermission(path: string): void {
    if (!this.hasBeenRead(path)) {
      throw new Error(
        `Cannot edit file '${path}': The file must be read first using the read tool before it can be edited. This is a safety measure to prevent accidental overwrites.`
      );
    }
  }
}

export type FsOperationType = typeof FsOperationType[keyof typeof FsOperationType];

export const FsOperationType = {
  Read: 'read',
  Write: 'write',
  Edit: 'edit',
  Delete: 'delete',
  Create: 'create',
} as const;

// Singleton instance
export const operationLog = new FsOperationLog();
