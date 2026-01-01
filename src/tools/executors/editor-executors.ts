/**
 * Editor Tool Executors
 * Implementations for editor tools that interact with the Monaco editor UI
 */

import { toolRegistry } from '../registry';
import { useEditorStore } from '../../store/useEditorStore';
import { loadFileContent } from '../../store/useWorkspaceStore';
import { isTauri, readFileContent } from '../../lib/tauri';
import { resolvePath } from '../utils/path-resolver';

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

    // Open file in editor using full path
    useEditorStore.getState().openFile(fullPath, filename, content, language);

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

// ============================================
// REGISTER ALL EDITOR EXECUTORS
// ============================================
export const registerEditorExecutors = (): void => {
  toolRegistry.registerExecutor('editor_open_file', editorOpenFileExecutor);
};
