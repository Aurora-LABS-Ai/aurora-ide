/**
 * Agent Window — per-thread task list (todo_write).
 *
 * The IDE's `useTaskStore` is a SINGLE global list — fine when only one turn can
 * run. The agent window runs turns in parallel across threads/projects, so a
 * global list would leak another thread's todos into whatever chat you're
 * viewing. This store keys the list by `threadId` so the docked task panel only
 * ever shows the open conversation's progress.
 *
 * Fed from `useAgentWindowSend` (it parses each `todo_write` tool call); read by
 * `AgentTaskPanel`. Memory-only and live, exactly like the IDE's task UI — the
 * conversation timeline keeps the durable history via the tool card.
 */

import { create } from "zustand";
import type { Task } from "../../store/useTaskStore";

export type { Task };

const areAllTerminal = (tasks: Task[]): boolean =>
  tasks.length > 0 &&
  tasks.every((t) => t.status === "completed" || t.status === "cancelled");

interface AgentTaskState {
  byThread: Record<string, Task[]>;
  /** Replace the list for a thread (empty array clears it). */
  setTasks: (threadId: string, tasks: Task[]) => void;
  /** Mark any still-pending/in-progress task as the turn's outcome. */
  finalize: (threadId: string, outcome: "completed" | "cancelled") => void;
  /** Drop a thread's list entirely. */
  clear: (threadId: string) => void;
}

export const useAgentTaskStore = create<AgentTaskState>((set) => ({
  byThread: {},

  setTasks: (threadId, tasks) =>
    set((s) => {
      if (tasks.length === 0) {
        if (!(threadId in s.byThread)) return s;
        const byThread = { ...s.byThread };
        delete byThread[threadId];
        return { byThread };
      }
      return { byThread: { ...s.byThread, [threadId]: tasks } };
    }),

  finalize: (threadId, outcome) =>
    set((s) => {
      const current = s.byThread[threadId];
      if (!current || current.length === 0 || areAllTerminal(current)) return s;
      const tasks = current.map((t) =>
        t.status === "completed" || t.status === "cancelled"
          ? t
          : { ...t, status: outcome },
      );
      return { byThread: { ...s.byThread, [threadId]: tasks } };
    }),

  clear: (threadId) =>
    set((s) => {
      if (!(threadId in s.byThread)) return s;
      const byThread = { ...s.byThread };
      delete byThread[threadId];
      return { byThread };
    }),
}));
