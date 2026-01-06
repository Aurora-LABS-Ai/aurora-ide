/**
 * Shared Path Resolution Utility
 * Single source of truth for resolving relative paths to absolute paths
 */
import { useWorkspaceStore } from "../../store/useWorkspaceStore";

/**
 * Strip Windows extended-length path prefix (\\?\)
 * This prefix is added by Windows path canonicalization but causes issues
 * with shell commands and some APIs that don't understand it.
 * 
 * Example: "\\?\E:\folder" -> "E:\folder"
 */
export function stripExtendedPathPrefix(path: string): string {
  if (path.startsWith('\\\\?\\')) {
    return path.slice(4);
  }
  return path;
}

/**
 * Get the file/folder name from a path
 */
export function getBaseName(path: string): string {
  const separator = getPathSeparator(path);
  return path.split(separator).pop() || '';
}

/**
 * Get the parent directory of a path
 */
export function getParentPath(path: string): string {
  const separator = getPathSeparator(path);
  const parts = path.split(separator);
  parts.pop();
  return parts.join(separator);
}

/**
 * Detect the path separator for the given path
 */
export function getPathSeparator(path: string): string {
  return path.includes('\\') ? '\\' : '/';
}

/**
 * Get the current workspace root path
 * This is the single point of access to the workspace store for tools
 */
export function getWorkspaceRootPath(): string | null {
  return useWorkspaceStore.getState().rootPath;
}

/**
 * Check if a path is absolute
 */
export function isAbsolutePath(path: string): boolean {
  // Windows absolute path (e.g., C:\, D:\)
  if (/^[A-Za-z]:[/\\]/.test(path)) {
    return true;
  }
  // Unix absolute path
  if (path.startsWith('/')) {
    return true;
  }
  return false;
}

/**
 * Normalize path separators to match the root path style
 */
export function normalizePath(path: string, rootPath: string): string {
  const separator = getPathSeparator(rootPath);
  const otherSeparator = separator === '\\' ? '/' : '\\';
  return path.replace(new RegExp(`\\${otherSeparator}`, 'g'), separator);
}

/**
 * Ensure workspace is available, throws if not
 */
export function requireWorkspace(): string {
  const rootPath = getWorkspaceRootPath();
  if (!rootPath) {
    throw new Error('No workspace open');
  }
  return rootPath;
}

/**
 * Resolve a relative path against the workspace root
 *
 * @param inputPath - The path to resolve (can be relative or absolute)
 * @param rootPath - Optional root path override (defaults to workspace root)
 * @returns The resolved absolute path (always without \\?\ prefix)
 */
export function resolvePath(inputPath: string | undefined, rootPath?: string): string {
  // Get root and strip any \\?\ prefix
  let root = rootPath ?? getWorkspaceRootPath();
  if (root) {
    root = stripExtendedPathPrefix(root);
  }

  // If no root path available, return input as-is (also stripped)
  if (!root) {
    return inputPath ? stripExtendedPathPrefix(inputPath) : '';
  }

  // Handle empty, current directory references
  if (!inputPath || inputPath === '.' || inputPath === './') {
    return root;
  }

  // Strip prefix from input if present
  const cleanInput = stripExtendedPathPrefix(inputPath);

  // If it's already an absolute path, normalize and return
  if (isAbsolutePath(cleanInput)) {
    return normalizePath(cleanInput, root);
  }

  // Join with root path
  const separator = getPathSeparator(root);

  // Remove leading ./ or / from the input path
  const cleanedInput = cleanInput.replace(/^\.?[/\\]/, '');

  // Normalize the input path to use the same separator as root
  const normalizedInput = normalizePath(cleanedInput, root);

  return `${root}${separator}${normalizedInput}`;
}
