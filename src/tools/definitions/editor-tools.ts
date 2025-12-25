/**
 * Editor Tools - Definitions
 * Tools for interacting with the code editor UI
 */

import type { ToolDefinition } from '../types';

// ============================================
// EDITOR OPEN FILE TOOL
// ============================================
export const editorOpenFileTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'editor_open_file',
    description: 'Open a file in the code editor. Optionally navigate to a specific line.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'The full path of the file to open',
        },
        line: {
          type: 'number',
          description: 'Line number to navigate to (1-indexed)',
        },
        column: {
          type: 'number',
          description: 'Column number to navigate to (1-indexed)',
        },
      },
      required: ['path'],
    },
  },
};

// ============================================
// EDITOR GET ACTIVE FILE TOOL
// ============================================
export const editorGetActiveFileTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'editor_get_active_file',
    description: 'Get information about the currently active file in the editor including path, content, and cursor position.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
};

// ============================================
// EDITOR GET SELECTION TOOL
// ============================================
export const editorGetSelectionTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'editor_get_selection',
    description: 'Get the currently selected text in the active editor.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
};

// ============================================
// EDITOR INSERT TEXT TOOL
// ============================================
export const editorInsertTextTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'editor_insert_text',
    description: 'Insert text at the current cursor position or replace the current selection in the active editor.',
    parameters: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: 'The text to insert',
        },
      },
      required: ['text'],
    },
  },
};

// ============================================
// EDITOR GET OPEN TABS TOOL
// ============================================
export const editorGetOpenTabsTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'editor_get_open_tabs',
    description: 'Get a list of all currently open tabs/files in the editor.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
};

// ============================================
// EDITOR CLOSE TAB TOOL
// ============================================
export const editorCloseTabTool: ToolDefinition = {
  type: 'function',
  function: {
    name: 'editor_close_tab',
    description: 'Close a tab in the editor by file path.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'The path of the file/tab to close',
        },
        save: {
          type: 'boolean',
          description: 'Whether to save the file before closing if it has unsaved changes. Defaults to true.',
          default: true,
        },
      },
      required: ['path'],
    },
  },
};

// Export all editor tools as an array
export const editorTools: ToolDefinition[] = [
  editorOpenFileTool,
  editorGetActiveFileTool,
  editorGetSelectionTool,
  editorInsertTextTool,
  editorGetOpenTabsTool,
  editorCloseTabTool,
];

