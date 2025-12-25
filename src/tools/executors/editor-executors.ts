/**
 * Editor Tool Executors
 * Implementations for editor tools that interact with the Monaco editor UI
 */

import { toolRegistry } from '../registry';
import { useEditorStore } from '../../store/useEditorStore';
import { loadFileContent } from '../../store/useWorkspaceStore';
import { isTauri, readFileContent, writeFileContent } from '../../lib/tauri';

// ============================================
// EDITOR OPEN FILE EXECUTOR
// ============================================
const editorOpenFileExecutor = async (args: Record<string, any>): Promise<string> => {
  const { path, line, column } = args;

  if (!path) {
    return JSON.stringify({ success: false, error: 'Path is required' });
  }

  try {
    // Get filename from path
    const filename = path.split(/[/\\]/).pop() || path;
    
    // Load file content
    let content = '';
    if (isTauri()) {
      content = await readFileContent(path);
    } else {
      content = await loadFileContent(path);
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

    // Open file in editor
    useEditorStore.getState().openFile(path, filename, content, language);

    // TODO: Navigate to line/column when Monaco ref is available
    // For now, just acknowledge the request
    return JSON.stringify({
      success: true,
      message: `Opened file: ${filename}`,
      path,
      line: line || 1,
      column: column || 1,
    });
  } catch (error) {
    console.error('[editor_open_file] Error:', error);
    return JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

// ============================================
// EDITOR GET ACTIVE FILE EXECUTOR
// ============================================
const editorGetActiveFileExecutor = async (): Promise<string> => {
  try {
    const { tabs, activeTabId } = useEditorStore.getState();
    const activeTab = tabs.find(t => t.id === activeTabId);

    if (!activeTab) {
      return JSON.stringify({
        success: true,
        hasActiveFile: false,
        message: 'No file is currently open',
      });
    }

    return JSON.stringify({
      success: true,
      hasActiveFile: true,
      path: activeTab.path,
      filename: activeTab.filename,
      language: activeTab.language,
      isDirty: activeTab.isDirty,
      contentLength: activeTab.content.length,
      lineCount: activeTab.content.split('\n').length,
    });
  } catch (error) {
    console.error('[editor_get_active_file] Error:', error);
    return JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

// ============================================
// EDITOR GET SELECTION EXECUTOR
// ============================================
const editorGetSelectionExecutor = async (): Promise<string> => {
  // Note: This requires Monaco editor integration
  // For now, return a placeholder response
  return JSON.stringify({
    success: true,
    hasSelection: false,
    message: 'Selection retrieval requires Monaco editor integration',
    selectedText: '',
  });
};

// ============================================
// EDITOR INSERT TEXT EXECUTOR
// ============================================
const editorInsertTextExecutor = async (args: Record<string, any>): Promise<string> => {
  const { text } = args;

  if (!text) {
    return JSON.stringify({ success: false, error: 'Text is required' });
  }

  try {
    const { tabs, activeTabId } = useEditorStore.getState();
    const activeTab = tabs.find(t => t.id === activeTabId);

    if (!activeTab) {
      return JSON.stringify({
        success: false,
        error: 'No active file to insert text into',
      });
    }

    // Append text to content (basic implementation)
    // Full implementation would need Monaco cursor position
    const newContent = activeTab.content + text;
    useEditorStore.getState().updateTabContent(activeTabId!, newContent);

    return JSON.stringify({
      success: true,
      message: 'Text inserted at end of file',
      path: activeTab.path,
      insertedLength: text.length,
    });
  } catch (error) {
    console.error('[editor_insert_text] Error:', error);
    return JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

// ============================================
// EDITOR GET OPEN TABS EXECUTOR
// ============================================
const editorGetOpenTabsExecutor = async (): Promise<string> => {
  try {
    const { tabs, activeTabId } = useEditorStore.getState();

    const tabInfo = tabs.map(tab => ({
      path: tab.path,
      filename: tab.filename,
      language: tab.language,
      isDirty: tab.isDirty,
      isActive: tab.id === activeTabId,
    }));

    return JSON.stringify({
      success: true,
      count: tabs.length,
      activeTabPath: tabs.find(t => t.id === activeTabId)?.path || null,
      tabs: tabInfo,
    });
  } catch (error) {
    console.error('[editor_get_open_tabs] Error:', error);
    return JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

// ============================================
// EDITOR CLOSE TAB EXECUTOR
// ============================================
const editorCloseTabExecutor = async (args: Record<string, any>): Promise<string> => {
  const { path, save = true } = args;

  if (!path) {
    return JSON.stringify({ success: false, error: 'Path is required' });
  }

  try {
    const { tabs, closeTab } = useEditorStore.getState();
    const tab = tabs.find(t => t.path === path);

    if (!tab) {
      return JSON.stringify({
        success: false,
        error: `No open tab found for path: ${path}`,
      });
    }

    // Save if requested and dirty
    if (save && tab.isDirty && isTauri()) {
      await writeFileContent(path, tab.content);
    }

    // Close the tab
    closeTab(tab.id);

    return JSON.stringify({
      success: true,
      message: `Closed tab: ${tab.filename}`,
      path,
      wasSaved: save && tab.isDirty,
    });
  } catch (error) {
    console.error('[editor_close_tab] Error:', error);
    return JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

// ============================================
// REGISTER ALL EDITOR EXECUTORS
// ============================================
export const registerEditorExecutors = (): void => {
  toolRegistry.registerExecutor('editor_open_file', editorOpenFileExecutor);
  toolRegistry.registerExecutor('editor_get_active_file', editorGetActiveFileExecutor);
  toolRegistry.registerExecutor('editor_get_selection', editorGetSelectionExecutor);
  toolRegistry.registerExecutor('editor_insert_text', editorInsertTextExecutor);
  toolRegistry.registerExecutor('editor_get_open_tabs', editorGetOpenTabsExecutor);
  toolRegistry.registerExecutor('editor_close_tab', editorCloseTabExecutor);
};

