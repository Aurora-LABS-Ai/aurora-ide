/**
 * THEME ARCHITECTURE NOTICE:
 *
 * This project uses a centralized theme system. DO NOT use hardcoded colors.
 * Use theme tokens via CSS variables.
 */

import React, { useState, useCallback, useRef, useEffect } from 'react';
import {
  Search,
  X,
  ChevronDown,
  ChevronRight,
  RefreshCw,
  CaseSensitive,
  Regex,
} from 'lucide-react';
import { useWorkspaceStore, loadFileContent } from '../../store/useWorkspaceStore';
import { useEditorStore } from '../../store/useEditorStore';
import { FileIcon } from '../explorer/FileIcons';
import type { FileNode } from '../../types';

interface SearchResult {
  filePath: string;
  fileName: string;
  matches: SearchMatch[];
}

interface SearchMatch {
  line: number;
  content: string;
  matchStart: number;
  matchEnd: number;
}

export const SearchPanel: React.FC = () => {
  const { rootPath, files } = useWorkspaceStore();
  const { openFile } = useEditorStore();

  const [searchQuery, setSearchQuery] = useState('');
  const [searchMode, setSearchMode] = useState<'files' | 'content'>('files');
  const [isSearching, setIsSearching] = useState(false);
  const [fileResults, setFileResults] = useState<FileNode[]>([]);
  const [contentResults, setContentResults] = useState<SearchResult[]>([]);
  const [expandedFiles, setExpandedFiles] = useState<Set<string>>(new Set());
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [useRegex, setUseRegex] = useState(false);

  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Focus search input on mount
  useEffect(() => {
    searchInputRef.current?.focus();
  }, []);

  // Flatten file tree for searching
  const flattenFiles = useCallback((nodes: FileNode[], result: FileNode[] = []): FileNode[] => {
    for (const node of nodes) {
      if (node.type === 'file') {
        result.push(node);
      } else if (node.children) {
        flattenFiles(node.children, result);
      }
    }
    return result;
  }, []);

  // Search file names
  const searchFileNames = useCallback((query: string) => {
    if (!query.trim()) {
      setFileResults([]);
      return;
    }

    const allFiles = flattenFiles(files);
    const lowerQuery = caseSensitive ? query : query.toLowerCase();

    let matches: FileNode[];
    if (useRegex) {
      try {
        const regex = new RegExp(query, caseSensitive ? '' : 'i');
        matches = allFiles.filter(f => regex.test(f.name));
      } catch {
        matches = [];
      }
    } else {
      matches = allFiles.filter(f => {
        const name = caseSensitive ? f.name : f.name.toLowerCase();
        return name.includes(lowerQuery);
      });
    }

    // Sort by relevance (exact match first, then starts with, then contains)
    matches.sort((a, b) => {
      const aName = caseSensitive ? a.name : a.name.toLowerCase();
      const bName = caseSensitive ? b.name : b.name.toLowerCase();

      const aExact = aName === lowerQuery;
      const bExact = bName === lowerQuery;
      if (aExact && !bExact) return -1;
      if (!aExact && bExact) return 1;

      const aStarts = aName.startsWith(lowerQuery);
      const bStarts = bName.startsWith(lowerQuery);
      if (aStarts && !bStarts) return -1;
      if (!aStarts && bStarts) return 1;

      return a.name.localeCompare(b.name);
    });

    setFileResults(matches.slice(0, 100)); // Limit results
  }, [files, flattenFiles, caseSensitive, useRegex]);

  // Search file contents
  const searchFileContents = useCallback(async (query: string) => {
    if (!query.trim() || !rootPath) {
      setContentResults([]);
      return;
    }

    setIsSearching(true);
    const allFiles = flattenFiles(files);
    const results: SearchResult[] = [];

    try {
      const regex = useRegex
        ? new RegExp(query, caseSensitive ? 'g' : 'gi')
        : null;

      // Search through files (limit to prevent hanging)
      const filesToSearch = allFiles.slice(0, 500);

      for (const file of filesToSearch) {
        if (!file.path) continue;

        // Skip binary/large files by extension
        const ext = file.name.split('.').pop()?.toLowerCase();
        const skipExtensions = ['png', 'jpg', 'jpeg', 'gif', 'ico', 'svg', 'woff', 'woff2', 'ttf', 'eot', 'mp3', 'mp4', 'zip', 'tar', 'gz'];
        if (ext && skipExtensions.includes(ext)) continue;

        try {
          const content = await loadFileContent(file.path);
          const lines = content.split('\n');
          const matches: SearchMatch[] = [];

          for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            let hasMatch = false;
            let matchStart = 0;
            let matchEnd = 0;

            if (regex) {
              const match = regex.exec(line);
              if (match) {
                hasMatch = true;
                matchStart = match.index;
                matchEnd = match.index + match[0].length;
                regex.lastIndex = 0; // Reset for next search
              }
            } else {
              const searchIn = caseSensitive ? line : line.toLowerCase();
              const searchFor = caseSensitive ? query : query.toLowerCase();
              const idx = searchIn.indexOf(searchFor);
              if (idx !== -1) {
                hasMatch = true;
                matchStart = idx;
                matchEnd = idx + query.length;
              }
            }

            if (hasMatch) {
              matches.push({
                line: i + 1,
                content: line.trim().slice(0, 200), // Truncate long lines
                matchStart,
                matchEnd,
              });

              // Limit matches per file
              if (matches.length >= 10) break;
            }
          }

          if (matches.length > 0) {
            results.push({
              filePath: file.path,
              fileName: file.name,
              matches,
            });

            // Limit total results
            if (results.length >= 50) break;
          }
        } catch {
          // Skip files that can't be read
        }
      }
    } catch (error) {
      console.error('Search error:', error);
    }

    setContentResults(results);
    // Auto-expand all results
    setExpandedFiles(new Set(results.map(r => r.filePath)));
    setIsSearching(false);
  }, [files, flattenFiles, rootPath, caseSensitive, useRegex]);

  // Handle search input change with debounce
  const handleSearchChange = useCallback((value: string) => {
    setSearchQuery(value);

    if (searchTimeoutRef.current) {
      clearTimeout(searchTimeoutRef.current);
    }

    searchTimeoutRef.current = setTimeout(() => {
      if (searchMode === 'files') {
        searchFileNames(value);
      } else {
        searchFileContents(value);
      }
    }, searchMode === 'files' ? 100 : 300);
  }, [searchMode, searchFileNames, searchFileContents]);

  // Handle file click - open in editor
  const handleFileClick = useCallback(async (filePath: string, fileName: string, _line?: number) => {
    const { selectFile } = useWorkspaceStore.getState();
    selectFile(filePath);

    try {
      // Load content first, then open file - prevents "// Loading..." flash
      const content = await loadFileContent(filePath);
      openFile(filePath, fileName, content, undefined);
      // TODO: If line is provided, scroll to that line in the editor
    } catch (err) {
      console.error('Failed to load file:', err);
      openFile(filePath, fileName, `// Failed to load file: ${err}`, undefined);
    }
  }, [openFile]);

  // Toggle file expansion in content results
  const toggleFileExpansion = useCallback((filePath: string) => {
    setExpandedFiles(prev => {
      const next = new Set(prev);
      if (next.has(filePath)) {
        next.delete(filePath);
      } else {
        next.add(filePath);
      }
      return next;
    });
  }, []);

  // Clear search
  const handleClear = useCallback(() => {
    setSearchQuery('');
    setFileResults([]);
    setContentResults([]);
    searchInputRef.current?.focus();
  }, []);

  return (
    <div className="h-full flex flex-col" style={{ background: 'var(--aurora-sidebar-background)' }}>
      {/* Header */}
      <div
        className="h-9 px-3 flex items-center justify-between border-b shrink-0"
        style={{ borderColor: 'var(--aurora-common-border)' }}
      >
        <span
          className="text-[11px] font-bold uppercase tracking-wide"
          style={{ color: 'var(--aurora-sidebar-foreground)', opacity: 0.7 }}
        >
          Search
        </span>
      </div>

      {/* Search Mode Tabs */}
      <div className="flex border-b" style={{ borderColor: 'var(--aurora-common-border)' }}>
        <button
          onClick={() => { setSearchMode('files'); setFileResults([]); setContentResults([]); }}
          className="flex-1 px-3 py-2 text-[11px] font-medium transition-colors"
          style={{
            color: searchMode === 'files' ? 'var(--aurora-common-primary)' : 'var(--aurora-sidebar-foreground)',
            borderBottom: searchMode === 'files' ? '2px solid var(--aurora-common-primary)' : '2px solid transparent',
            opacity: searchMode === 'files' ? 1 : 0.6,
          }}
        >
          Files
        </button>
        <button
          onClick={() => { setSearchMode('content'); setFileResults([]); setContentResults([]); }}
          className="flex-1 px-3 py-2 text-[11px] font-medium transition-colors"
          style={{
            color: searchMode === 'content' ? 'var(--aurora-common-primary)' : 'var(--aurora-sidebar-foreground)',
            borderBottom: searchMode === 'content' ? '2px solid var(--aurora-common-primary)' : '2px solid transparent',
            opacity: searchMode === 'content' ? 1 : 0.6,
          }}
        >
          In Files
        </button>
      </div>

      {/* Search Input */}
      <div className="p-3 border-b" style={{ borderColor: 'var(--aurora-common-border)' }}>
        <div className="relative">
          <Search
            className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4"
            style={{ color: 'var(--aurora-sidebar-foreground)', opacity: 0.5 }}
          />
          <input
            ref={searchInputRef}
            type="text"
            value={searchQuery}
            onChange={(e) => handleSearchChange(e.target.value)}
            placeholder={searchMode === 'files' ? 'Search file names...' : 'Search in files...'}
            className="w-full pl-9 pr-20 py-2 text-[13px] rounded-lg outline-none"
            style={{
              background: 'var(--aurora-editor-background)',
              color: 'var(--aurora-editor-foreground)',
              border: '1px solid var(--aurora-common-border)',
            }}
          />
          <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1">
            <button
              onClick={() => setCaseSensitive(!caseSensitive)}
              className="p-1 rounded transition-colors"
              style={{
                color: caseSensitive ? 'var(--aurora-common-primary)' : 'var(--aurora-sidebar-foreground)',
                background: caseSensitive ? 'var(--aurora-common-primary)20' : 'transparent',
                opacity: caseSensitive ? 1 : 0.5,
              }}
              title="Match Case"
            >
              <CaseSensitive className="w-4 h-4" />
            </button>
            <button
              onClick={() => setUseRegex(!useRegex)}
              className="p-1 rounded transition-colors"
              style={{
                color: useRegex ? 'var(--aurora-common-primary)' : 'var(--aurora-sidebar-foreground)',
                background: useRegex ? 'var(--aurora-common-primary)20' : 'transparent',
                opacity: useRegex ? 1 : 0.5,
              }}
              title="Use Regular Expression"
            >
              <Regex className="w-4 h-4" />
            </button>
            {searchQuery && (
              <button
                onClick={handleClear}
                className="p-1 rounded hover:bg-white/10 transition-colors"
                style={{ color: 'var(--aurora-sidebar-foreground)' }}
              >
                <X className="w-4 h-4" />
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Results */}
      <div className="flex-1 overflow-y-auto">
        {isSearching && (
          <div className="flex items-center justify-center py-8">
            <RefreshCw className="w-5 h-5 animate-spin" style={{ color: 'var(--aurora-common-primary)' }} />
          </div>
        )}

        {!isSearching && searchMode === 'files' && fileResults.length > 0 && (
          <div className="py-1">
            {fileResults.map((file) => (
              <div
                key={file.path}
                onClick={() => handleFileClick(file.path!, file.name)}
                className="px-3 py-1.5 flex items-center gap-2 hover:bg-white/5 cursor-pointer transition-colors"
              >
                <FileIcon name={file.name} path={file.path} className="w-4 h-4 shrink-0" />
                <span
                  className="text-[13px] truncate"
                  style={{ color: 'var(--aurora-sidebar-foreground)' }}
                >
                  {file.name}
                </span>
                <span
                  className="text-[11px] truncate ml-auto"
                  style={{ color: 'var(--aurora-sidebar-foreground)', opacity: 0.4 }}
                >
                  {file.path?.replace(rootPath || '', '').replace(/^[/\\]/, '')}
                </span>
              </div>
            ))}
          </div>
        )}

        {!isSearching && searchMode === 'content' && contentResults.length > 0 && (
          <div className="py-1">
            {contentResults.map((result) => (
              <div key={result.filePath}>
                {/* File header */}
                <div
                  onClick={() => toggleFileExpansion(result.filePath)}
                  className="px-3 py-1.5 flex items-center gap-2 hover:bg-white/5 cursor-pointer transition-colors"
                >
                  {expandedFiles.has(result.filePath) ? (
                    <ChevronDown className="w-4 h-4" style={{ color: 'var(--aurora-sidebar-foreground)', opacity: 0.5 }} />
                  ) : (
                    <ChevronRight className="w-4 h-4" style={{ color: 'var(--aurora-sidebar-foreground)', opacity: 0.5 }} />
                  )}
                  <FileIcon name={result.fileName} path={result.filePath} className="w-4 h-4 shrink-0" />
                  <span
                    className="text-[13px] truncate flex-1"
                    style={{ color: 'var(--aurora-sidebar-foreground)' }}
                  >
                    {result.fileName}
                  </span>
                  <span
                    className="text-[10px] px-1.5 py-0.5 rounded-full"
                    style={{ background: 'var(--aurora-common-primary)', color: 'white' }}
                  >
                    {result.matches.length}
                  </span>
                </div>

                {/* Match lines */}
                {expandedFiles.has(result.filePath) && (
                  <div className="ml-6">
                    {result.matches.map((match, idx) => (
                      <div
                        key={idx}
                        onClick={() => handleFileClick(result.filePath, result.fileName, match.line)}
                        className="px-3 py-1 flex items-start gap-2 hover:bg-white/5 cursor-pointer transition-colors"
                      >
                        <span
                          className="text-[11px] w-8 text-right shrink-0"
                          style={{ color: 'var(--aurora-common-primary)' }}
                        >
                          {match.line}
                        </span>
                        <span
                          className="text-[12px] font-mono truncate"
                          style={{ color: 'var(--aurora-sidebar-foreground)', opacity: 0.8 }}
                        >
                          {match.content}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {!isSearching && searchQuery && fileResults.length === 0 && contentResults.length === 0 && (
          <div className="flex flex-col items-center justify-center py-8 px-4 text-center">
            <Search className="w-8 h-8 mb-2" style={{ color: 'var(--aurora-sidebar-foreground)', opacity: 0.3 }} />
            <p className="text-[13px]" style={{ color: 'var(--aurora-sidebar-foreground)', opacity: 0.6 }}>
              No results found
            </p>
          </div>
        )}

        {!searchQuery && (
          <div className="flex flex-col items-center justify-center py-8 px-4 text-center">
            <Search className="w-8 h-8 mb-2" style={{ color: 'var(--aurora-sidebar-foreground)', opacity: 0.3 }} />
            <p className="text-[13px]" style={{ color: 'var(--aurora-sidebar-foreground)', opacity: 0.6 }}>
              {searchMode === 'files'
                ? 'Type to search for files by name'
                : 'Type to search within files'}
            </p>
          </div>
        )}
      </div>
    </div>
  );
};

export default SearchPanel;
