/**
 * Agent Window — docked task panel [view].
 *
 * A collapsible checklist docked directly above the composer that mirrors the
 * model's `todo_write` list for the OPEN thread (per-thread via
 * `useAgentTaskStore`, so a background turn's todos never leak in). Shows live
 * status — pending / in-progress (spinner) / completed / cancelled — with a
 * compact header summary so it stays useful while collapsed.
 *
 * Themed purely with `--agw-*`.
 */

import React, { useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";

import { AgentIcon } from "../shared/AgentIcon";
import { useAgentChatStore } from "../store/useAgentChatStore";
import { useAgentTaskStore, type Task } from "../store/useAgentTaskStore";

const StatusIcon: React.FC<{ status: Task["status"] }> = ({ status }) => {
  switch (status) {
    case "completed":
      return (
        <span className="agw-task-ico agw-task-ico-done">
          <AgentIcon name="check" size={11} strokeWidth={3} />
        </span>
      );
    case "in_progress":
      return <span className="agw-rail-spin agw-task-spin" aria-hidden />;
    case "cancelled":
      return (
        <span className="agw-task-ico agw-task-ico-cancel">
          <AgentIcon name="close" size={10} strokeWidth={2.5} />
        </span>
      );
    case "pending":
      return <span className="agw-task-ico agw-task-ico-pending" aria-hidden />;
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
};

export const AgentTaskPanel: React.FC = () => {
  const currentThreadId = useAgentChatStore((s) => s.currentThreadId);
  const tasks = useAgentTaskStore((s) =>
    currentThreadId ? s.byThread[currentThreadId] : undefined,
  );
  const clear = useAgentTaskStore((s) => s.clear);
  const [collapsed, setCollapsed] = useState(false);

  const { done, total, active, allDone } = useMemo(() => {
    const list = tasks ?? [];
    const completed = list.filter((t) => t.status === "completed").length;
    const inProgress = list.find((t) => t.status === "in_progress");
    return {
      done: completed,
      total: list.length,
      active: inProgress,
      allDone:
        list.length > 0 &&
        list.every((t) => t.status === "completed" || t.status === "cancelled"),
    };
  }, [tasks]);

  if (!tasks || tasks.length === 0) return null;

  return (
    <div className="agw-dock-card agw-tasks">
      <div className="agw-tasks-head">
        <button
          type="button"
          className="agw-tasks-toggle"
          aria-expanded={!collapsed}
          onClick={() => setCollapsed((c) => !c)}
        >
          <span className="agw-tasks-title">
            {allDone ? "Tasks complete" : active ? active.content : "Tasks"}
          </span>
          <span className="agw-tasks-count">
            {done}/{total}
          </span>
          <span
            className="agw-tasks-chev"
            data-collapsed={collapsed || undefined}
            aria-hidden
          >
            <AgentIcon name="chevron-down" size={14} />
          </span>
        </button>
        <button
          type="button"
          className="agw-tasks-x"
          title="Dismiss tasks"
          aria-label="Dismiss tasks"
          onClick={() => currentThreadId && clear(currentThreadId)}
        >
          <AgentIcon name="close" size={13} />
        </button>
      </div>

      <AnimatePresence initial={false}>
        {!collapsed && (
          <motion.div
            key="body"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18, ease: "easeOut" }}
            style={{ overflow: "hidden" }}
          >
            <ul className="agw-tasks-list">
              {tasks.map((task) => (
                <li
                  key={task.id}
                  className="agw-task-row"
                  data-status={task.status}
                >
                  <StatusIcon status={task.status} />
                  <span className="agw-task-label">{task.content}</span>
                </li>
              ))}
            </ul>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};
