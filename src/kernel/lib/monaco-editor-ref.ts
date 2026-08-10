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

/**
 * Visual-only (NON-undoable) write for the live-streaming preview path.
 *
 * `replaceMonacoFileContent` pushes an undo entry on every call — fine for
 * the *final* commit, but during the streaming phase the agent's tool args
 * arrive in dozens of chunks. Pushing one undo entry per chunk would mean
 * the user has to Ctrl+Z 50 times to revert a single AI write.
 *
 * Solution: during streaming use `model.applyEdits`, which mutates the
 * model in place without touching the undo stack. The user sees the
 * file content fill in live but Monaco's undo history is untouched.
 * Once the Rust runtime emits the post-write `agent_file_changed` event,
 * the global file-sync handler calls `replaceMonacoFileContent` to lay
 * down the final state as ONE undoable entry — restoring the
 * "Ctrl+Z reverts the AI edit" contract.
 *
 * Returns `true` when the model was found and the edit applied;
 * `false` when no editor is mounted for `path` (caller can fall back
 * to the Zustand tab state, which the live-preview service already does).
 */
export const streamPreviewMonacoFileContent = (
  path: string,
  partialContent: string,
): boolean => {
  const editorInstance = getMonacoEditorForPath(path);
  if (!editorInstance) return false;

  const model = editorInstance.getModel();
  if (!model) return false;

  if (model.getValue() === partialContent) return true;

  // `applyEdits` does NOT push to the undo stack — that's the whole
  // point of using it here over `pushEditOperations`. The intermediate
  // streaming chunks should be invisible to undo; only the final
  // committed state (applied via `replaceMonacoFileContent` from the
  // file_changed handler) deserves an undo entry.
  model.applyEdits([
    {
      range: model.getFullModelRange(),
      text: partialContent,
      forceMoveMarkers: true,
    },
  ]);
  return true;
};

/**
 * Commit a finalised AI edit that was previously previewed via
 * `streamPreviewMonacoFileContent`.
 *
 * The model is currently at the "preview" state (last streamed chunk).
 * To make the AI edit one clean undo entry — Ctrl+Z reverts the entire
 * AI write, not just the last chunk — we:
 *
 *   1. Silently snap the model back to `originalContent` via
 *      `applyEdits` (no undo entry).
 *   2. Push the final content through `pushEditOperations` (one undo
 *      entry).
 *
 * Both happen in the same synchronous tick, so the user never sees the
 * intermediate "back to original" flash — Monaco coalesces the two
 * mutations into a single repaint.
 *
 * Returns `true` when applied, `false` when no editor is mounted for
 * `path` (the caller's Zustand fallback handles that case).
 */
export const commitStreamedMonacoFileContent = (
  path: string,
  originalContent: string,
  finalContent: string,
): boolean => {
  const editorInstance = getMonacoEditorForPath(path);
  if (!editorInstance) return false;

  const model = editorInstance.getModel();
  if (!model) return false;

  if (model.getValue() === finalContent && originalContent === finalContent) {
    return true;
  }

  // Step 1 — silently restore the pre-AI-edit content. `applyEdits`
  // mutates the model without touching the undo stack, so the user
  // can't tell this happened.
  if (model.getValue() !== originalContent) {
    model.applyEdits([
      {
        range: model.getFullModelRange(),
        text: originalContent,
        forceMoveMarkers: true,
      },
    ]);
  }

  // Step 2 — push the final content as ONE undoable edit. Ctrl+Z
  // reverts the AI write back to `originalContent`.
  if (originalContent !== finalContent) {
    model.pushEditOperations(
      editorInstance.getSelections() ?? null,
      [
        {
          range: model.getFullModelRange(),
          text: finalContent,
          forceMoveMarkers: true,
        },
      ],
      () => null,
    );
  }

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
