/**
 * Monaco Editor Reference Bridge
 *
 * Single source of truth for live Monaco editor instances mounted in the IDE.
 * Two registries are tracked:
 *
 *   1. `activeEditor` — the currently focused/visible editor. Used by the
 *      tab-bar undo/redo buttons that need to dispatch into "whatever the
 *      user is looking at".
 *
 *   2. `editorsByPath` — every mounted editor keyed by its absolute file
 *      path. Used by AI tool executors (`file_write`, `file_create`,
 *      `search_replace`, `multi_search_replace`) to apply content changes
 *      *through Monaco's native edit pipeline* so each AI edit becomes one
 *      undoable entry on the model's undo stack.
 *
 * Why this exists:
 *
 * The previous implementation pushed AI edits via `tab.content` -> React
 * `value` prop -> `model.setValue()`. `setValue` *clears the undo stack*,
 * so Ctrl+Z immediately after an AI edit did nothing (Monaco had no history
 * to roll back). We also kept a parallel Rust + Zustand undo stack that
 * nobody was actually wiring through Ctrl+Z, which made the whole feature
 * feel broken.
 *
 * The fix: when the file is open in Monaco, route AI edits through
 * `model.pushEditOperations` (an undoable batch). Monaco records the AI
 * write as a single entry, and the user's native Ctrl+Z reverts it just
 * like a manual paste — exactly how VS Code, Cursor, and JetBrains behave.
 * When the file isn't open we fall through to the legacy `tab.content`
 * path, which is fine because there's no editor view to maintain history
 * for in the first place.
 */

import type { editor } from "monaco-editor";

let activeEditor: editor.IStandaloneCodeEditor | null = null;

// Path -> editor map. Populated/cleaned on mount/dispose.
const editorsByPath = new Map<string, editor.IStandaloneCodeEditor>();

const normalizePath = (path: string): string => path.replace(/\\/g, "/");

export const setActiveMonacoEditor = (
  editorInstance: editor.IStandaloneCodeEditor | null,
) => {
  activeEditor = editorInstance;
};

export const getActiveMonacoEditor = (): editor.IStandaloneCodeEditor | null => {
  return activeEditor;
};

/**
 * Register a Monaco editor instance for a given file path.
 *
 * Returns an unregister callback that should be invoked from the editor's
 * `onDispose` (or React effect cleanup) so we never hand AI tools a stale
 * pointer to a torn-down editor.
 */
export const registerMonacoEditorForPath = (
  path: string,
  editorInstance: editor.IStandaloneCodeEditor,
): (() => void) => {
  const key = normalizePath(path);
  editorsByPath.set(key, editorInstance);
  return () => {
    if (editorsByPath.get(key) === editorInstance) {
      editorsByPath.delete(key);
    }
  };
};

export const getMonacoEditorForPath = (
  path: string,
): editor.IStandaloneCodeEditor | null => {
  return editorsByPath.get(normalizePath(path)) ?? null;
};

/**
 * Replace the entire content of a Monaco-managed file through an undoable
 * edit operation. Returns `true` if the edit was applied via Monaco (the
 * caller can rely on the model + view being consistent and the undo stack
 * having grown by one entry); `false` if no editor is currently open for
 * this path and the caller should fall back to the regular tab/content
 * pipeline.
 *
 * The edit uses `pushEditOperations` with a no-op cursor mapper so cursor
 * position is preserved across the swap when possible. A dedicated source
 * label (`aurora.ai`) lets future tooling group these in the undo stack
 * UI without confusing them with user keystrokes.
 */
export const replaceMonacoFileContent = (
  path: string,
  newContent: string,
): boolean => {
  const editorInstance = getMonacoEditorForPath(path);
  if (!editorInstance) return false;

  const model = editorInstance.getModel();
  if (!model) return false;

  // No-op edits would still push an entry onto the undo stack and dirty
  // the buffer — skip them entirely so AI tools that "rewrite the same
  // content" don't cost the user a Ctrl+Z press to recover.
  if (model.getValue() === newContent) return true;

  const fullRange = model.getFullModelRange();
  model.pushEditOperations(
    editorInstance.getSelections() ?? null,
    [
      {
        range: fullRange,
        text: newContent,
        forceMoveMarkers: true,
      },
    ],
    () => null,
  );
  return true;
};

export const triggerMonacoUndo = () => {
  if (activeEditor) {
    activeEditor.focus();
    // Use requestAnimationFrame to ensure focus is complete before
    // dispatching the keyboard action.
    requestAnimationFrame(() => {
      if (activeEditor) {
        activeEditor.trigger("keyboard", "undo", null);
      }
    });
  }
};

export const triggerMonacoRedo = () => {
  if (activeEditor) {
    activeEditor.focus();
    requestAnimationFrame(() => {
      if (activeEditor) {
        activeEditor.trigger("keyboard", "redo", null);
      }
    });
  }
};
