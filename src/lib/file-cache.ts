/**
 * High-performance file content cache for the frontend.
 * 
 * This module provides:
 * - LRU cache for file contents (reduces IPC calls)
 * - Batch file reading (single IPC call for multiple files)
 * - Optimistic cache updates
 * - Automatic invalidation on file changes
 */
import { invoke } from "@tauri-apps/api/core";

import { isTauri } from "./tauri";

// Cache entry with content and timestamp
interface CacheEntry {
  content: string;
  size: number;
  timestamp: number;
}

/**
 * Frontend LRU file cache
 * Works in conjunction with the Rust backend cache for maximum performance
 */
class FileCache {
  private accessOrder: string[] = []; // Most recently accessed at end
  private cache: Map<string, CacheEntry> = new Map();
  private totalSize: number = 0;

  /**
   * Clear the entire cache
   */
  public clear(): void {
    this.cache.clear();
    this.accessOrder = [];
    this.totalSize = 0;
  }

  /**
   * Get file content from cache
   * Returns null if not cached or expired
   */
  public get(path: string): string | null {
    const entry = this.cache.get(path);
    if (!entry) return null;

    // Check if entry is too old (needs revalidation)
    const age = Date.now() - entry.timestamp;
    if (age > MAX_CACHE_AGE_MS) {
      return null; // Force refetch to ensure freshness
    }

    // Update access order (move to end)
    this.touchAccessOrder(path);

    return entry.content;
  }

  /**
   * Invalidate a specific path
   */
  public invalidate(path: string): void {
    const entry = this.cache.get(path);
    if (entry) {
      this.totalSize -= entry.size;
      this.cache.delete(path);
      this.removeFromAccessOrder(path);
    }
  }

  /**
   * Invalidate all paths under a directory prefix
   */
  public invalidatePrefix(prefix: string): void {
    const normalizedPrefix = prefix.replace(/\\/g, '/');
    const toRemove: string[] = [];

    for (const path of this.cache.keys()) {
      const normalizedPath = path.replace(/\\/g, '/');
      if (normalizedPath.startsWith(normalizedPrefix)) {
        toRemove.push(path);
      }
    }

    for (const path of toRemove) {
      this.invalidate(path);
    }
  }

  /**
   * Cache file content
   */
  public set(path: string, content: string): void {
    const size = content.length * 2; // Approximate UTF-16 size

    // Remove old entry for this path
    if (this.cache.has(path)) {
      const old = this.cache.get(path)!;
      this.totalSize -= old.size;
      this.removeFromAccessOrder(path);
    }

    // Evict old entries if we exceed max size
    while (this.totalSize + size > MAX_CACHE_SIZE && this.accessOrder.length > 0) {
      const oldestPath = this.accessOrder.shift()!;
      const oldEntry = this.cache.get(oldestPath);
      if (oldEntry) {
        this.totalSize -= oldEntry.size;
        this.cache.delete(oldestPath);
      }
    }

    // Add new entry
    this.cache.set(path, {
      content,
      timestamp: Date.now(),
      size,
    });
    this.totalSize += size;
    this.accessOrder.push(path);
  }

  /**
   * Get cache statistics
   */
  public stats(): { entries: number; size: number } {
    return {
      entries: this.cache.size,
      size: this.totalSize,
    };
  }

  private removeFromAccessOrder(path: string): void {
    const idx = this.accessOrder.indexOf(path);
    if (idx !== -1) {
      this.accessOrder.splice(idx, 1);
    }
  }

  private touchAccessOrder(path: string): void {
    const idx = this.accessOrder.indexOf(path);
    if (idx !== -1) {
      this.accessOrder.splice(idx, 1);
      this.accessOrder.push(path);
    }
  }
}

/**
 * Debug: Get cache statistics
 */
export function getCacheStats(): { entries: number; size: number } {
  return fileCache.stats();
}

/**
 * Invalidate cache for a path (after file modification)
 */
export function invalidateFileCache(path: string, isPrefix: boolean = false): void {
  if (isPrefix) {
    fileCache.invalidatePrefix(path);
  } else {
    fileCache.invalidate(path);
  }

  // Also notify Rust backend to invalidate its cache
  if (isTauri()) {
    invoke('invalidate_file_cache', { path, isPrefix }).catch(err => {
      console.warn('Failed to invalidate Rust cache:', err);
    });
  }
}

/**
 * Preload files into cache in the background
 * Useful for preloading files the user is likely to open next
 */
export function preloadFiles(paths: string[]): void {
  if (!isTauri() || paths.length === 0) return;

  // Filter out already cached paths
  const toPreload = paths.filter(p => fileCache.get(p) === null);
  if (toPreload.length === 0) return;

  // Preload in background (don't await)
  readFilesBatch(toPreload).catch(err => {
    console.warn('Background preload failed:', err);
  });
}

/**
 * Read file content with frontend caching
 * Falls through to Rust backend cache if not in frontend cache
 */
export async function readFileCached(path: string): Promise<string> {
  if (!isTauri()) {
    console.warn('readFileCached: Not running in Tauri');
    return '';
  }

  // Check frontend cache first (instant)
  const cached = fileCache.get(path);
  if (cached !== null) {
    return cached;
  }

  // Fall through to Rust backend (which also has a cache)
  const content = await invoke<string>('read_file_content', { path });

  // Cache in frontend
  fileCache.set(path, content);

  return content;
}

/**
 * Read multiple files in a single IPC call
 * This is the key performance optimization for batch operations
 */
export async function readFilesBatch(paths: string[]): Promise<Map<string, string>> {
  if (!isTauri()) {
    console.warn('readFilesBatch: Not running in Tauri');
    return new Map();
  }

  if (paths.length === 0) {
    return new Map();
  }

  // Check which files are already cached
  const results = new Map<string, string>();
  const uncachedPaths: string[] = [];

  for (const path of paths) {
    const cached = fileCache.get(path);
    if (cached !== null) {
      results.set(path, cached);
    } else {
      uncachedPaths.push(path);
    }
  }

  // If all were cached, return immediately (no IPC!)
  if (uncachedPaths.length === 0) {
    return results;
  }

  // Batch read uncached files from Rust
  const batchResults = await invoke<Record<string, { Ok?: string; Err?: string }>>('read_files_batch', {
    paths: uncachedPaths,
  });

  // Process results and update cache
  for (const [path, result] of Object.entries(batchResults)) {
    if (result.Ok !== undefined) {
      fileCache.set(path, result.Ok);
      results.set(path, result.Ok);
    } else {
      console.warn(`Failed to read file ${path}:`, result.Err);
    }
  }

  return results;
}

// Maximum age for cached entries (5 minutes) - after this, we'll check with Rust cache
const MAX_CACHE_AGE_MS = 5 * 60 * 1000;

// Maximum cache size in bytes (50MB)
const MAX_CACHE_SIZE = 50 * 1024 * 1024;

// Global cache instance
export const fileCache = new FileCache();
