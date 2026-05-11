/**
 * Agent IDE Event Listeners
 * =========================
 *
 * Subscribes to the fire-and-forget Tauri events emitted by the
 * Rust `shell_editor_todo` tools (`editor_open_file`, `read_lints`,
 * `todo_write`) and applies them to the Zustand stores so the IDE
 * UI reflects what the agent just did.
 *
 * Channels (matched against Rust constants in
 * `src-tauri/src/tools/shell_editor_todo/ide_event_sink.rs`):
 *
 *   - `agent_editor_open` → open file in Monaco, optionally reveal
 *     a line/column.
 *   - `agent_read_lints`  → no-op for now. The Rust tool is
 *     fire-and-forget; Monaco already updates its diagnostics
 *     pane natively, so we only log the request for visibility.
 *   - `agent_todo_write`  → push the new task list into the
 *     `useTaskStore` (mirrors the legacy TS executor's behaviour).
 *
 * Lifecycle: `installAgentIdeListeners()` returns an `unlisten`
 * that detaches every channel. App-level effect calls it once on
 * mount and disposes on unmount.
 */
import { auroraListen } from "../lib/runtime";
import { isTauri, readFileContent } from "../lib/tauri";
import { useEditorStore } from "../store/useEditorStore";
import { useTaskStore } from "../store/useTaskStore";
import { loadFileContent } from "../store/useWorkspaceStore";

interface EditorOpenPayload {
  path: string;
  line?: number;
  column?: number;
}

interface ReadLintsPayload {
  paths?: string[];
}

interface TodoItemPayload {
  activeForm?: string;
  content: string;
  status: "pending" | "in_progress" | "completed";
}

interface TodoWritePayload {
  todos?: TodoItemPayload[];
}

const LARGE_FILE_THRESHOLD = 100 * 1024;

const LANGUAGE_BY_EXT: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  json: "json",
  css: "css",
  scss: "scss",
  html: "html",
  md: "markdown",
  rs: "rust",
  toml: "toml",
  yaml: "yaml",
  yml: "yaml",
  py: "python",
  go: "go",
};

const detectLanguage = (filename: string): string => {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  return LANGUAGE_BY_EXT[ext] ?? "plaintext";
};

const handleEditorOpen = async ({ path, line, column }: EditorOpenPayload): Promise<void> => {
  if (!path) return;
  try {
    const filename = path.split(/[/\\]/).pop() || path;
    const content = isTauri()
      ? await readFileContent(path)
      : await loadFileContent(path);
    const isLargeFile = content.length > LARGE_FILE_THRESHOLD;

    useEditorStore
      .getState()
      .openFile(
        path,
        filename,
        content,
        isLargeFile ? "plaintext" : detectLanguage(filename),
      );

    if (line || column) {
      useEditorStore.getState().requestEditorReveal(path, {
        mode: "line",
        lineNumber: line ?? 1,
        column: column ?? 1,
        focus: true,
      });
    }
  } catch (err) {
    console.error("[agent-ide-events] editor_open failed:", path, err);
  }
};

const handleTodoWrite = ({ todos }: TodoWritePayload): void => {
  if (!Array.isArray(todos) || todos.length === 0) {
    useTaskStore.getState().setTasks([]);
    return;
  }

  const existingTasks = useTaskStore.getState().tasks;
  const taskList = todos.map((todo, index) => {
    const existing = existingTasks.find(
      (task) =>
        task.originalContent === todo.content ||
        task.content === todo.activeForm ||
        task.content === todo.content,
    );
    const id = existing?.id ?? `task_${Date.now()}_${index}`;
    const display =
      todo.status === "in_progress" && todo.activeForm
        ? todo.activeForm
        : todo.content;
    return {
      id,
      activeForm: todo.activeForm,
      content: display,
      originalContent: todo.content,
      status: todo.status,
    };
  });

  useTaskStore.getState().setTasks(taskList);
};

/**
 * Wire all Rust→frontend IDE listeners. Call once at app startup;
 * dispose with the returned cleanup on unmount.
 */
export const installAgentIdeListeners = async (): Promise<() => void> => {
  const cleanups: Array<() => void> = [];

  cleanups.push(
    await auroraListen<EditorOpenPayload>("agent_editor_open", ({ payload }) => {
      void handleEditorOpen(payload);
    }),
  );

  cleanups.push(
    await auroraListen<ReadLintsPayload>("agent_read_lints", ({ payload }) => {
      // Monaco already surfaces diagnostics natively in the gutter;
      // the agent just used the call to nudge a refresh on its
      // mental model. Log for debug visibility — no UI mutation.
      const paths = payload.paths ?? [];
      console.debug(
        `[agent-ide-events] read_lints requested for ${
          paths.length === 0 ? "all open files" : paths.join(", ")
        }`,
      );
    }),
  );

  cleanups.push(
    await auroraListen<TodoWritePayload>("agent_todo_write", ({ payload }) => {
      handleTodoWrite(payload);
    }),
  );

  return () => {
    for (const cleanup of cleanups) {
      try {
        cleanup();
      } catch (err) {
        console.warn("[agent-ide-events] cleanup threw:", err);
      }
    }
  };
};
