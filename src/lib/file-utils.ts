/**
 * File Utilities
 * Common file path and language detection utilities
 */

/**
 * Get file path from drag data transfer
 */
export const getDragFilePath = (e: React.DragEvent): string | null => {
    const internalPath = e.dataTransfer.getData(DND_FILE_PATH_KEY) || e.dataTransfer.getData('text/plain');
    if (internalPath) {
        return internalPath;
    }

    const nativeFile = e.dataTransfer.files?.[0] as File & { path?: string };
    return nativeFile?.path || null;
};

/**
 * Get filename from a full path
 */
export const getFilename = (path: string): string => {
    return path.split(/[/\\]/).pop() || path;
};

/**
 * Get language identifier from file extension or well-known filename for Monaco editor.
 */
export const getLanguageFromExtension = (filename: string): string => {
    const normalized = getFilename(filename).trim().toLowerCase();
    if (!normalized) return 'plaintext';

    // Handle compound declaration files.
    if (
        normalized.endsWith('.d.ts') ||
        normalized.endsWith('.d.mts') ||
        normalized.endsWith('.d.cts')
    ) {
        return 'typescript';
    }

    const byNameMap: Record<string, string> = {
        'dockerfile': 'dockerfile',
        'makefile': 'makefile',
        'cmakelists.txt': 'cmake',
        'justfile': 'plaintext',
        'jenkinsfile': 'groovy',
        '.bashrc': 'shell',
        '.zshrc': 'shell',
        '.profile': 'shell',
        '.gitignore': 'plaintext',
    };
    if (byNameMap[normalized]) {
        return byNameMap[normalized];
    }

    const ext = normalized.includes('.') ? normalized.split('.').pop() || '' : '';
    const langMap: Record<string, string> = {
        // TypeScript/JavaScript
        'ts': 'typescript',
        'tsx': 'typescript',
        'mts': 'typescript',
        'cts': 'typescript',
        'js': 'javascript',
        'jsx': 'javascript',
        'mjs': 'javascript',
        'cjs': 'javascript',
        // Web
        'json': 'json',
        'css': 'css',
        'scss': 'scss',
        'sass': 'scss',
        'less': 'less',
        'html': 'html',
        'htm': 'html',
        'xhtml': 'html',
        'md': 'markdown',
        'mdx': 'markdown',
        'vue': 'vue',
        'svelte': 'svelte',
        // Systems
        'rs': 'rust',
        'toml': 'toml',
        'lock': 'toml',
        'go': 'go',
        'c': 'c',
        'cpp': 'cpp',
        'cc': 'cpp',
        'cxx': 'cpp',
        'h': 'cpp',
        'hpp': 'cpp',
        // Other languages
        'py': 'python',
        'pyw': 'python',
        'java': 'java',
        'kt': 'kotlin',
        'scala': 'scala',
        'rb': 'ruby',
        'php': 'php',
        'swift': 'swift',
        'r': 'r',
        'lua': 'lua',
        'sh': 'shell',
        'bash': 'shell',
        'zsh': 'shell',
        'fish': 'shell',
        'ps1': 'powershell',
        'psm1': 'powershell',
        'psd1': 'powershell',
        'bat': 'bat',
        'cmd': 'bat',
        // Config/Data
        'yaml': 'yaml',
        'yml': 'yaml',
        'sql': 'sql',
        'graphql': 'graphql',
        'gql': 'graphql',
        'xml': 'xml',
        'ini': 'ini',
        'conf': 'ini',
        'env': 'ini',
        'txt': 'plaintext',
    };
    return langMap[ext] || 'plaintext';
};

/**
 * Get the path separator based on the path format
 */
export const getPathSeparator = (path: string): string => {
    return path.includes('\\') ? '\\' : '/';
};

/**
 * Get parent directory from a full path
 */
export const getParentPath = (path: string): string => {
    const sep = getPathSeparator(path);
    return path.substring(0, path.lastIndexOf(sep));
};

/**
 * Check if childPath is inside parentPath
 */
export const isChildPath = (parentPath: string, childPath: string): boolean => {
    const parentNorm = parentPath.replace(/\\/g, '/').toLowerCase();
    const childNorm = childPath.replace(/\\/g, '/').toLowerCase();
    return childNorm.startsWith(parentNorm + '/');
};

/**
 * Join path segments
 */
export const joinPath = (basePath: string, ...segments: string[]): string => {
    const sep = getPathSeparator(basePath);
    return [basePath, ...segments].join(sep);
};

/**
 * Set file path in drag data transfer
 */
export const setDragFilePath = (e: React.DragEvent, path: string): void => {
    e.dataTransfer.setData(DND_FILE_PATH_KEY, path);
    e.dataTransfer.setData('text/plain', path);
    e.dataTransfer.effectAllowed = 'copyMove';
};

/**
 * Drag-drop data transfer key for file paths
 */
export const DND_FILE_PATH_KEY = 'application/x-aurora-file-path';
