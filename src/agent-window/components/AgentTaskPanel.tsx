/**
 * Agent Window — task checklist body [view].
 *
 * The list itself. Its only host is the header's {@link TaskIndicator} card,
 * which owns open/closed and paints the surface — so this renders the head and
 * the rows and nothing else. It previously carried a second `dock` presentation
 * (its own card above the composer, with its own collapse chevron); that host
 * is gone, and a collapse control inside a popover is a lid on an already-closed
 * box.
 *
 * Four states with distinct SHAPES, never colour alone: pending (hollow ring),
 * running (spinner), paused (ring with a held centre), done (tick), cancelled
 * (cross).
 *
 * Paused is the honest answer to a task left in_progress by a turn that ended.
 * The panel used to flip those to "completed" when the turn finished, which
 * showed a tick for work the agent had abandoned. A spinner would be just as
 * wrong in the other direction — nothing is running. Same rule the Canvas
 * applies to plan steps: liveness is whether THIS conversation is streaming.
 *
 * Themed purely with `--agw-*`.
 */

import React, { useMemo } from "react";

import { AgentIcon } from "../shared/AgentIcon";
import { useAgentChatStore } from "../store/useAgentChatStore";
import { useAgentTaskStore, type Task } from "../store/useAgentTaskStore";

/** What a row shows — `status`, resolved against whether the turn is running. */
type RowState = Task["status"] | "paused";

const resolveRowState = (task: Task, isStreaming: boolean): RowState =>
  task.status === "in_progress" && !isStreaming ? "paused" : task.status;

const STATE_LABEL: Record<RowState, string> = {
  pending: "Not started",
  in_progress: "In progress",
  paused: "Paused",
  completed: "Done",
  cancelled: "Cancelled",
};

const StatusIcon: React.FC<{ state: RowState }> = ({ state }) => {
  switch (state) {
    case "completed":
      return (
        <span className="agw-task-ico agw-task-ico-done">
          <AgentIcon name="check" size={11} strokeWidth={3} />
        </span>
      );
    case "in_progress":
      return <span className="agw-rail-spin agw-task-spin" aria-hidden />;
    case "paused":
      return <span className="agw-task-ico agw-task-ico-paused" aria-hidden />;
    case "cancelled":
      return (
        <span className="agw-task-ico agw-task-ico-cancel">
          <AgentIcon name="close" size={10} strokeWidth={2.5} />
        </span>
      );
    case "pending":
      return <span className="agw-task-ico agw-task-ico-pending" aria-hidden />;
    default: {
      const _exhaustive: never = state;
      return _exhaustive;
    }
  }
};

export const AgentTaskPanel: React.FC = () => {
  const currentThreadId = useAgentChatStore((s) => s.currentThreadId);
  const tasks = useAgentTaskStore((s) =>
    currentThreadId ? s.byThread[currentThreadId] : undefined,
  );
  // Is THIS conversation streaming right now? A task can only be running if it
  // is — see the paused rationale in the module docs.
  const isStreaming = useAgentChatStore((s) =>
    currentThreadId ? !!s.liveTurns[currentThreadId] : false,
  );
  const clear = useAgentTaskStore((s) => s.clear);

  const { done, total, active, allDone } = useMemo(() => {
    const list = tasks ?? [];
    return {
      // CLOSED, not completed. The header indicator counts the same way, and
      // two different numbers for one list on one screen is a bug. Counting
      // only `completed` also contradicted this component's own `allDone`: a
      // list ending in a cancelled task showed "Tasks complete  2/3".
      done: list.filter(
        (t) => t.status === "completed" || t.status === "cancelled",
      ).length,
      total: list.length,
      active: list.find((t) => t.status === "in_progress"),
      allDone:
        list.length > 0 &&
        list.every((t) => t.status === "completed" || t.status === "cancelled"),
    };
  }, [tasks]);

  if (!tasks || tasks.length === 0) return null;

  // The head answers "what is happening right now" — including when the answer
  // is "nothing". A paused task reads in the imperative ("Add the route"),
  // never the present continuous, which would claim work is under way.
  const heading = allDone
    ? "Tasks complete"
    : active
      ? isStreaming
        ? active.content
        : `Paused — ${active.originalContent ?? active.content}`
      : "Tasks";

  return (
    // `.agw-crail-panel` is the shared popover-body shape (head band + scrolling
    // well) that the background-process panel already uses. Reused rather than
    // reinvented so the two floating panels in this window stay one thing.
    <div className="agw-crail-panel">
      <div className="agw-tasks-head">
        <span className="agw-tasks-toggle" data-static>
          <span className="agw-tasks-title">{heading}</span>
          <span className="agw-tasks-count">
            {done}/{total}
          </span>
        </span>
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

      <div className="agw-crail-panel-body agw-scroll">
        <ul className="agw-tasks-list">
          {tasks.map((task) => {
            const state = resolveRowState(task, isStreaming);
            // A paused row keeps the imperative title for the same reason.
            const label =
              state === "paused" ? (task.originalContent ?? task.content) : task.content;
            return (
              <li key={task.id} className="agw-task-row" data-status={state}>
                <StatusIcon state={state} />
                <span className="agw-task-label">{label}</span>
                {/* The glyphs are the visual signal; this is the same
                    information for a screen reader, which cannot see a
                    spinner or a tick. */}
                <span className="agw-sr-only">{STATE_LABEL[state]}</span>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
};
