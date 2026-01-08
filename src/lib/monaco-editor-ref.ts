/**
 * Global reference to the active Monaco editor instance.
 * Used for programmatic undo/redo operations.
 */

import type { editor } from 'monaco-editor';

let activeEditor: editor.IStandaloneCodeEditor | null = null;

export const setActiveMonacoEditor = (editorInstance: editor.IStandaloneCodeEditor | null) => {
  activeEditor = editorInstance;
};

export const getActiveMonacoEditor = (): editor.IStandaloneCodeEditor | null => {
  return activeEditor;
};

export const triggerMonacoUndo = () => {
  if (activeEditor) {
    activeEditor.focus();
    // Use requestAnimationFrame to ensure focus is complete
    requestAnimationFrame(() => {
      if (activeEditor) {
        activeEditor.trigger('keyboard', 'undo', null);
      }
    });
  }
};

export const triggerMonacoRedo = () => {
  if (activeEditor) {
    activeEditor.focus();
    // Use requestAnimationFrame to ensure focus is complete
    requestAnimationFrame(() => {
      if (activeEditor) {
        activeEditor.trigger('keyboard', 'redo', null);
      }
    });
  }
};

