/**
 * Agent Window — per-thread task list (the agent's working checklist).
 *
 * The IDE's `useTaskStore` is a SINGLE global list — fine when only one turn can
 * run. The agent window runs turns in parallel across threads/projects, so a
 * global list would leak another thread's todos into whatever chat you're
 * viewing. This store keys the list by `threadId` so the docked task panel only
 * ever shows the open conversation's progress.
 *
 * **Rust owns the list; this is a projection of it.** It arrives two ways, and
 * both carry the same payload: `agent_todo_write` (live, on every todo tool
 * call) and `todo_list_for_thread` (cold start, when a conversation is opened).
 *
 * This used to be built on the frontend by parsing `todo_write` tool-call
 * arguments as they streamed. That copy watched exactly one of the tools that
 * change the list, so `todo_update` — the tool the agent uses for nearly all
 * progress — moved nothing: the panel sat at 0/N with the first row spinning
 * while the agent worked through the whole list. Never reconstruct state the
 * backend already owns.
 */

import { create } from "zustand";

import { auroraInvoke, auroraListen, type AuroraUnlistenFn } from "@/kernel/lib/ipc/runtime";
import type { Task } from "@/apps/agent/store/tools/useTaskStore";

export type { Task };

/** One item exactly as Rust's `TodoList::to_event_payload` emits it. */
export interface TodoPayloadItem {
  id: string;
  content: string;
  activeForm?: string;
  status: Task["status"];
}

interface TodoWriteEvent {
  threadId?: string;
  todos?: TodoPayloadItem[];
}

/** The Tauri channel Rust emits on after every todo tool call. */
export const TODO_WRITE_EVENT = "agent_todo_write";

/**
 * Rust ids are stable across calls (`t1`, `t2`, …), so they are the row key.
 * The frontend used to mint `task_${Date.now()}_${i}` and then try to re-find
 * the old row by matching text — which broke the moment a title was reworded.
 */
const toTask = (todo: TodoPayloadItem): Task => ({
  id: todo.id,
  activeForm: todo.activeForm,
  content:
    todo.status === "in_progress" && todo.activeForm
      ? todo.activeForm
      : todo.content,
  originalContent: todo.content,
  status: todo.status,
});

const parseTodos = (todos: unknown): Task[] =>
  Array.isArray(todos)
    ? todos
        .filter(
          (todo): todo is TodoPayloadItem =>
            !!todo &&
            typeof todo === "object" &&
            typeof (todo as TodoPayloadItem).id === "string" &&
            typeof (todo as TodoPayloadItem).content === "string",
        )
        .map(toTask)
    : [];

interface AgentTaskState {
  byThread: Record<string, Task[]>;
  /**
   * Threads the user dismissed with the panel's ✕, so a thread switch does not
   * resurrect a checklist they closed on purpose. Any new activity on the
   * thread clears the flag — the dismissal hides a list, it does not mute one.
   */
  dismissed: Record<string, true | undefined>;
  /** Replace the list for a thread (empty array clears it). */
  setTasks: (threadId: string, tasks: Task[]) => void;
  /** Apply a Rust payload — from the live event or the cold-start read. */
  applyTodos: (threadId: string, todos: unknown) => void;
  /** Read a conversation's list from disk if this window has never seen it. */
  hydrate: (threadId: string) => Promise<void>;
  /** Drop a thread's list from the panel (the user dismissed it). */
  clear: (threadId: string) => void;
}

/** Shared by `setTasks` and `applyTodos`: an empty list removes the panel. */
const writeTasks = (
  s: AgentTaskState,
  threadId: string,
  tasks: Task[],
): Partial<AgentTaskState> | AgentTaskState => {
  if (tasks.length === 0) {
    if (!(threadId in s.byThread)) return s;
    const byThread = { ...s.byThread };
    delete byThread[threadId];
    return { byThread };
  }
  return { byThread: { ...s.byThread, [threadId]: tasks } };
};

export const useAgentTaskStore = create<AgentTaskState>((set, get) => ({
  byThread: {},
  dismissed: {},

  setTasks: (threadId, tasks) => set((s) => writeTasks(s, threadId, tasks)),

  applyTodos: (threadId, todos) => {
    if (!threadId) return;
    const tasks = parseTodos(todos);
    set((s) => ({
      ...writeTasks(s, threadId, tasks),
      // The agent touched this list, so it is worth showing again.
      dismissed: { ...s.dismissed, [threadId]: undefined },
    }));
  },

  hydrate: async (threadId) => {
    if (!threadId) return;
    const state = get();
    // Cold start only. The event subscription keeps EVERY thread current for
    // as long as the window is open, including ones running in the background,
    // so a thread already in the map is at least as fresh as the file. Reading
    // it again would also race: the read could be issued before a tool's write
    // and resolve after its event, replaying a stale list over a newer one.
    if (threadId in state.byThread || state.dismissed[threadId]) return;
    try {
      const todos = await auroraInvoke<unknown>("todo_list_for_thread", {
        threadId,
      });
      // Re-check: an event may have landed while the read was in flight, and it
      // is by definition newer than what the read started with.
      if (threadId in get().byThread) return;
      get().applyTodos(threadId, todos);
    } catch (error) {
      // No Tauri runtime, or a thread with no sidecar. An absent checklist is
      // a normal state; never fail opening a conversation over it.
      console.debug("[useAgentTaskStore] hydrate skipped:", error);
    }
  },

  clear: (threadId) =>
    set((s) => {
      const byThread = { ...s.byThread };
      delete byThread[threadId];
      return { byThread, dismissed: { ...s.dismissed, [threadId]: true } };
    }),
}));

/**
 * Window-lifetime subscription to `agent_todo_write`.
 *
 * Deliberately never torn down, for the same reason as the plan subscription:
 * the panel is a dock surface that mounts and unmounts, and a checklist that
 * changed while it was closed must still be correct when it reopens.
 */
let todoSubscription: Promise<AuroraUnlistenFn | undefined> | undefined;

export const subscribeToTodoChanges = (): Promise<
  AuroraUnlistenFn | undefined
> => {
  if (todoSubscription) return todoSubscription;
  todoSubscription = auroraListen<TodoWriteEvent>(
    TODO_WRITE_EVENT,
    ({ payload }) => {
      // `threadId` is what makes this routable. An event without one predates
      // the field or came from a surface that cannot name its conversation;
      // applying it to the open chat would show one conversation's progress
      // under another, which is worse than showing nothing.
      if (!payload?.threadId) return;
      useAgentTaskStore.getState().applyTodos(payload.threadId, payload.todos);
    },
  ).catch(() => {
    // No Tauri runtime (web preview / tests). Clearing the cached promise lets
    // a later attempt succeed.
    todoSubscription = undefined;
    return undefined;
  });
  return todoSubscription;
};
