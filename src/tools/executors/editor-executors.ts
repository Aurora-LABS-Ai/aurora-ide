/**
 * Editor Tool Executors
 * Implementations for editor tools that interact with the Monaco editor UI
 */
import { isTauri, readFileContent } from "../../lib/tauri";
import { useEditorStore } from "../../store/useEditorStore";
import { loadFileContent } from "../../store/useWorkspaceStore";
import { toolRegistry } from "../registry";
import { resolvePath } from "../utils/path-resolver";

interface DiagnosticInfo {
  column: number;
  endColumn: number;
  endLine: number;
  file: string;
  line: number;
  message: string;
  severity: 'error' | 'warning' | 'info' | 'hint';
  source?: string;
}

// ============================================
// EDITOR OPEN FILE EXECUTOR
// ============================================
const editorOpenFileExecutor = async (args: Record<string, unknown>): Promise<string> => {
  const path = args.path as string;
  const line = args.line as number | undefined;
  const column = args.column as number | undefined;

  if (!path) {
    return JSON.stringify({ success: false, error: 'Path is required' });
  }

  try {
    // Resolve relative paths to full paths
    const fullPath = resolvePath(path);

    // Get filename from path
    const filename = fullPath.split(/[/\\]/).pop() || fullPath;

    // Load file content
    let content = '';
    if (isTauri()) {
      content = await readFileContent(fullPath);
    } else {
      content = await loadFileContent(fullPath);
    }

    // Detect language from extension
    const ext = filename.split('.').pop()?.toLowerCase() || '';
    const langMap: Record<string, string> = {
      'ts': 'typescript', 'tsx': 'typescript',
      'js': 'javascript', 'jsx': 'javascript',
      'json': 'json', 'css': 'css', 'scss': 'scss',
      'html': 'html', 'md': 'markdown',
      'rs': 'rust', 'toml': 'toml',
      'yaml': 'yaml', 'yml': 'yaml',
      'py': 'python', 'go': 'go',
    };
    const language = langMap[ext] || 'plaintext';
    // Must match threshold in useEditorStore.ts
    const LARGE_FILE_THRESHOLD = 100 * 1024; // 100KB
    const isLargeFile = content.length > LARGE_FILE_THRESHOLD;

    // Open file in editor using full path
    useEditorStore.getState().openFile(
      fullPath,
      filename,
      content,
      isLargeFile ? 'plaintext' : language
    );

    if (line || column) {
      useEditorStore.getState().requestEditorReveal(fullPath, {
        mode: 'line',
        lineNumber: line || 1,
        column: column || 1,
        focus: true,
      });
    }

    return JSON.stringify({
      success: true,
      message: `Opened file: ${filename}`,
      path: fullPath,
      line: line || 1,
      column: column || 1,
    });
  } catch (error) {
    console.error('[editor_open_file] Error:', error);
    return JSON.stringify({
      success: false,
      error: `File does not exist: ${path}`,
    });
  }
};
const readLintsExecutor = async (args: Record<string, unknown>): Promise<string> => {
  const paths = (args.paths as string[] | undefined) || [];

  if (!monacoInstance) {
    return JSON.stringify({
      success: false,
      error: 'Monaco editor not initialized. Please open a file first.',
    });
  }

  try {
    // Get all markers (diagnostics) from Monaco
    const allMarkers = monacoInstance.editor.getModelMarkers({});

    // Map severity numbers to strings
    const severityMap: Record<number, DiagnosticInfo['severity']> = {
      1: 'hint',
      2: 'info',
      4: 'warning',
      8: 'error',
    };

    // Filter markers by paths if provided
    let filteredMarkers = allMarkers;
    if (paths.length > 0) {
      const resolvedPaths = paths.map(p => resolvePath(p).toLowerCase());
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      filteredMarkers = allMarkers.filter((marker: any) => {
        const markerPath = marker.resource.path.toLowerCase();
        // Check if marker path matches any of the requested paths
        return resolvedPaths.some(rp =>
          markerPath.includes(rp.replace(/\\/g, '/')) ||
          markerPath.endsWith(rp.split(/[/\\]/).pop() || '')
        );
      });
    }

    // Convert to our format
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const diagnostics: DiagnosticInfo[] = filteredMarkers.map((marker: any) => ({
      file: marker.resource.path,
      line: marker.startLineNumber,
      column: marker.startColumn,
      endLine: marker.endLineNumber,
      endColumn: marker.endColumn,
      message: marker.message,
      severity: severityMap[marker.severity] || 'info',
      source: marker.source || undefined,
    }));

    // Group by file
    const byFile: Record<string, DiagnosticInfo[]> = {};
    for (const diag of diagnostics) {
      const fileName = diag.file.split('/').pop() || diag.file;
      if (!byFile[fileName]) {
        byFile[fileName] = [];
      }
      byFile[fileName].push(diag);
    }

    // Count by severity
    const errorCount = diagnostics.filter(d => d.severity === 'error').length;
    const warningCount = diagnostics.filter(d => d.severity === 'warning').length;

    if (diagnostics.length === 0) {
      return JSON.stringify({
        success: true,
        message: 'No linter errors found.',
        totalErrors: 0,
        totalWarnings: 0,
        diagnostics: [],
      });
    }

    // Format output similar to Cursor's read_lints
    const formattedOutput = diagnostics.map(d => {
      const fileName = d.file.split('/').pop() || d.file;
      return `${fileName}:${d.line}:${d.column} - ${d.severity}: ${d.message}${d.source ? ` [${d.source}]` : ''}`;
    }).join('\n');

    return JSON.stringify({
      success: true,
      totalErrors: errorCount,
      totalWarnings: warningCount,
      totalDiagnostics: diagnostics.length,
      filesWithIssues: Object.keys(byFile).length,
      summary: `Found ${errorCount} error(s) and ${warningCount} warning(s) in ${Object.keys(byFile).length} file(s).`,
      formatted: formattedOutput,
      diagnostics,
    });
  } catch (error) {
    console.error('[read_lints] Error:', error);
    return JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const getMonacoInstance = (): any => {
  return monacoInstance;
};

// ============================================
// REGISTER ALL EDITOR EXECUTORS
// ============================================
export const registerEditorExecutors = (): void => {
  toolRegistry.registerExecutor('editor_open_file', editorOpenFileExecutor);
  toolRegistry.registerExecutor('read_lints', readLintsExecutor);
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const setMonacoInstance = (monaco: any): void => {
  monacoInstance = monaco;
};

// ============================================
// READ LINTS EXECUTOR (Monaco Diagnostics)
// ============================================

// Store reference to Monaco instance (set by CodeEditor component)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let monacoInstance: any = null;
