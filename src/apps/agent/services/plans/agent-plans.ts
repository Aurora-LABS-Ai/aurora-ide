import { auroraInvoke } from "@/kernel/lib/ipc/runtime";

/** Lifecycle of a plan document as a whole. */
export type PlanStatus = "draft" | "active" | "done" | "failed" | "abandoned";

/** Where a single step stands. */
export type PlanStepStatus =
  | "pending"
  | "in_progress"
  | "done"
  | "failed"
  | "skipped";

export interface PlanStep {
  id: string;
  title: string;
  status: PlanStepStatus;
  startedAt?: string;
  endedAt?: string;
  /**
   * The conversation that claimed this step while marking it `in_progress`.
   *
   * This is the liveness key: a step only counts as *running* when this
   * matches a thread that is streaming right now. Without that check a step
   * abandoned by a stopped run would animate forever — see
   * {@link resolvePlanStepState}.
   */
  runId?: string;
  paths?: string[];
  note?: string;
}

export interface PlanCursor {
  activeStepId: string | null;
  nextStepId: string | null;
  done: number;
  failed: number;
  skipped: number;
  pending: number;
  total: number;
  complete: boolean;
}

/** One `##` section of the plan body, bound to a step. */
export interface PlanSection {
  stepId: string | null;
  heading: string;
  level: number;
  content: string;
}

export interface PlanView {
  id: string;
  title: string;
  status: PlanStatus;
  createdAt: string;
  updatedAt: string;
  threadId: string | null;
  path: string;
  steps: PlanStep[];
  cursor: PlanCursor;
  overview: string;
  sections: PlanSection[];
  body: string;
}

export interface PlanSummary {
  id: string;
  title: string;
  status: PlanStatus;
  updatedAt: string;
  path: string;
  totalSteps: number;
  doneSteps: number;
}

/**
 * Why a plan changed.
 *
 * `authored` opens the Canvas — a written plan is the deliverable of a planning
 * conversation and the user should not have to hunt for a tab. `progress` does
 * not, because stealing the panel on every step flip would be hostile.
 */
export type PlanChangeReason = "authored" | "progress";

/** Payload of the `agent_plan_changed` Tauri event. */
export interface PlanChangedEvent {
  workspaceRoot: string;
  planId: string;
  threadId: string;
  reason: PlanChangeReason;
}

export const PLAN_CHANGED_EVENT = "agent_plan_changed";

/**
 * How a step should actually be presented, once liveness is taken into account.
 *
 * `running` is the only state that animates. `paused` is an `in_progress` step
 * whose owning run is not streaming — the user stopped, closed the window, or
 * came back hours later. Rendering that as a spinner would claim work is
 * happening when nothing is.
 */
export type PlanStepPresentation =
  | "pending"
  | "running"
  | "paused"
  | "done"
  | "failed"
  | "skipped";

export const resolvePlanStepState = (
  step: PlanStep,
  isRunLive: (runId: string) => boolean,
): PlanStepPresentation => {
  switch (step.status) {
    case "done":
      return "done";
    case "failed":
      return "failed";
    case "skipped":
      return "skipped";
    case "pending":
      return "pending";
    case "in_progress":
      // No claim at all means a hand-edited file or a user-set status — nothing
      // is executing it either way.
      return step.runId && isRunLive(step.runId) ? "running" : "paused";
    default: {
      const exhaustive: never = step.status;
      return exhaustive;
    }
  }
};

export const getActivePlan = (workspaceRoot: string): Promise<PlanView | null> =>
  auroraInvoke<PlanView | null>("plan_get_active", { workspaceRoot });

export const getPlan = (
  workspaceRoot: string,
  planId: string,
): Promise<PlanView | null> =>
  auroraInvoke<PlanView | null>("plan_get", { workspaceRoot, planId });

export const listPlans = (workspaceRoot: string): Promise<PlanSummary[]> =>
  auroraInvoke<PlanSummary[]>("plan_list", { workspaceRoot });

export const setPlanStepStatus = (
  workspaceRoot: string,
  planId: string,
  stepId: string,
  status: PlanStepStatus,
  note?: string,
): Promise<PlanView> =>
  auroraInvoke<PlanView>("plan_set_step_status", {
    request: { workspaceRoot, planId, stepId, status, note: note ?? null },
  });

export const savePlanBody = (
  workspaceRoot: string,
  planId: string,
  body: string,
): Promise<PlanView> =>
  auroraInvoke<PlanView>("plan_save_body", {
    request: { workspaceRoot, planId, body },
  });

export const setPlanStatus = (
  workspaceRoot: string,
  planId: string,
  status: PlanStatus,
): Promise<PlanView> =>
  auroraInvoke<PlanView>("plan_set_status", {
    request: { workspaceRoot, planId, status },
  });
