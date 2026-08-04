/**
 * Plan Canvas — the live plan document.
 *
 * Surface: app UI, expert audience, job = orient. The user needs to answer
 * "where does the work stand right now" in one glance and be able to trust the
 * answer, so the design rules are:
 *
 * - **One dominant element.** The running step is the only bright thing; every
 *   other step is dimmed. If nothing is running, the next step leads instead.
 * - **State is never carried by colour alone.** Every step shows an icon and a
 *   word, so the status survives colour-blindness and greyscale.
 * - **A spinner is a claim that work is happening.** It appears only when the
 *   owning run is actually streaming — see `resolvePlanStepState`. A step left
 *   in progress by a stopped run reads "Paused", with inline help explaining
 *   why, because that is the state the user hits after walking away.
 * - **Steps are a list with a status rail, not cards.** Cards would give twelve
 *   equal-weight boxes and destroy the hierarchy.
 */

import React, { useCallback, useEffect, useMemo, useState } from "react";

import type {
  PlanStepPresentation,
  PlanStepStatus,
  PlanView,
} from "../../services/agent-plans";
import { AgentIcon } from "../shared";
import { AgentMarkdown } from "./AgentMarkdown";

interface PlanCanvasProps {
  plan: PlanView;
  /** Presentation state per step id, liveness already applied. */
  states: Map<string, PlanStepPresentation>;
  onSetStepStatus: (stepId: string, status: PlanStepStatus) => Promise<void>;
  busy?: boolean;
}

const STATE_LABEL: Record<PlanStepPresentation, string> = {
  pending: "Not started",
  running: "Running",
  paused: "Paused",
  done: "Done",
  failed: "Failed",
  skipped: "Skipped",
};

/**
 * Recovery actions per state. Deliberately short: the agent drives progress,
 * so these exist for the cases where it got the state wrong — closed a step it
 * had not finished, or left one open after the user stopped it.
 */
const ACTIONS: Record<
  PlanStepPresentation,
  ReadonlyArray<{ label: string; status: PlanStepStatus }>
> = {
  pending: [{ label: "Skip", status: "skipped" }],
  running: [],
  paused: [
    { label: "Mark done", status: "done" },
    { label: "Reset to not started", status: "pending" },
  ],
  done: [{ label: "Reopen", status: "pending" }],
  failed: [{ label: "Reopen", status: "pending" }],
  skipped: [{ label: "Reopen", status: "pending" }],
};

const StepMarker: React.FC<{ state: PlanStepPresentation }> = ({ state }) => {
  if (state === "running") {
    // aria-hidden: the adjacent text label already announces "Running", so the
    // spinner would otherwise be read twice.
    return <span className="agw-plan-marker agw-plan-marker-running" aria-hidden />;
  }
  if (state === "done") {
    return (
      <span className="agw-plan-marker agw-plan-marker-done" aria-hidden>
        <AgentIcon name="check" size={12} />
      </span>
    );
  }
  if (state === "failed") {
    return (
      <span className="agw-plan-marker agw-plan-marker-failed" aria-hidden>
        <AgentIcon name="close" size={11} />
      </span>
    );
  }
  if (state === "skipped") {
    return <span className="agw-plan-marker agw-plan-marker-skipped" aria-hidden />;
  }
  if (state === "paused") {
    return <span className="agw-plan-marker agw-plan-marker-paused" aria-hidden />;
  }
  return <span className="agw-plan-marker" aria-hidden />;
};

export const PlanCanvas: React.FC<PlanCanvasProps> = ({
  plan,
  states,
  onSetStepStatus,
  busy,
}) => {
  const runningStepId = useMemo(
    () => plan.steps.find((step) => states.get(step.id) === "running")?.id,
    [plan.steps, states],
  );
  const [expanded, setExpanded] = useState<string | null>(null);
  const [pendingStepId, setPendingStepId] = useState<string | null>(null);

  // The running step opens itself: what the agent is doing right now is the one
  // thing the user came here to read.
  useEffect(() => {
    if (runningStepId) setExpanded(runningStepId);
  }, [runningStepId]);

  const detailFor = useCallback(
    (stepId: string) =>
      plan.sections.find((section) => section.stepId === stepId)?.content ?? "",
    [plan.sections],
  );

  const apply = async (stepId: string, status: PlanStepStatus) => {
    setPendingStepId(stepId);
    try {
      await onSetStepStatus(stepId, status);
    } finally {
      setPendingStepId(null);
    }
  };

  const { done, total } = plan.cursor;
  const percent = total > 0 ? Math.round((done / total) * 100) : 0;
  const runningStep = plan.steps.find((step) => step.id === runningStepId);

  return (
    <section className="agw-plan" aria-label={`Plan: ${plan.title}`}>
      <header className="agw-plan-head">
        <div className="agw-plan-headline">
          <h2 className="agw-plan-title">{plan.title}</h2>
          <span className="agw-plan-count">
            {done} of {total} done
          </span>
        </div>

        <div
          className="agw-plan-meter"
          role="progressbar"
          aria-valuenow={done}
          aria-valuemin={0}
          aria-valuemax={total}
          aria-label="Steps completed"
        >
          <span className="agw-plan-meter-fill" style={{ width: `${percent}%` }} />
        </div>

        {/* One live region for the whole plan: status changes are announced
            once, naming the step, instead of every row shouting on re-render. */}
        <p className="agw-plan-now" aria-live="polite">
          {runningStep
            ? `Running: ${runningStep.title}`
            : plan.cursor.complete
              ? plan.cursor.failed > 0
                ? "Every step is closed. Some did not succeed."
                : "Every step is done."
              : plan.cursor.nextStepId
                ? `Waiting to start: ${
                    plan.steps.find((s) => s.id === plan.cursor.nextStepId)?.title ?? ""
                  }`
                : "Nothing left to start."}
        </p>
      </header>

      {plan.overview.trim().length > 0 && (
        <div className="agw-plan-overview agw-md">
          <AgentMarkdown content={plan.overview} />
        </div>
      )}

      <ol className="agw-plan-steps">
        {plan.steps.map((step, index) => {
          const state = states.get(step.id) ?? "pending";
          const detail = detailFor(step.id);
          const isOpen = expanded === step.id;
          const actions = ACTIONS[state];
          const rowBusy = busy || pendingStepId === step.id;

          return (
            <li
              key={step.id}
              className="agw-plan-step"
              data-state={state}
              data-open={isOpen || undefined}
            >
              <button
                type="button"
                className="agw-plan-step-head"
                aria-expanded={isOpen}
                onClick={() => setExpanded(isOpen ? null : step.id)}
              >
                <StepMarker state={state} />
                <span className="agw-plan-step-index">{index + 1}</span>
                <span className="agw-plan-step-title">{step.title}</span>
                <span className="agw-plan-step-state">{STATE_LABEL[state]}</span>
                <AgentIcon
                  name="chevron-down"
                  size={13}
                  className="agw-plan-step-chevron"
                />
              </button>

              {/* Required help stays visible rather than hiding in a tooltip:
                  "Paused" is meaningless without knowing why it stopped. */}
              {state === "paused" && (
                <p className="agw-plan-step-help">
                  Marked in progress, but no run is working on it now. Send a
                  message to pick it back up.
                </p>
              )}

              {step.note && state !== "paused" && (
                <p className="agw-plan-step-note">{step.note}</p>
              )}

              {isOpen && (
                <div className="agw-plan-step-body">
                  {detail.trim().length > 0 ? (
                    <div className="agw-md">
                      <AgentMarkdown content={detail} />
                    </div>
                  ) : (
                    <p className="agw-plan-step-empty">
                      This step has no written detail.
                    </p>
                  )}

                  {actions.length > 0 && (
                    <div className="agw-plan-step-actions">
                      {actions.map((action) => (
                        <button
                          key={action.status}
                          type="button"
                          className="agw-plan-step-action"
                          disabled={rowBusy}
                          onClick={() => void apply(step.id, action.status)}
                        >
                          {rowBusy ? "Saving…" : action.label}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ol>

      {/* Metadata, not decoration: this is a real file the user can open, edit,
          and commit, which is the whole reason the plan is not hidden state. */}
      <footer className="agw-plan-foot">
        <span className="agw-plan-path" title={plan.path}>
          {plan.path}
        </span>
      </footer>
    </section>
  );
};
