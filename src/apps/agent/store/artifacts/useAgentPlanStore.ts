/**
 * Agent Window — the workspace's plan document.
 *
 * Keyed by **workspace root**, not by thread: a plan belongs to the folder, so
 * switching chats inside a project keeps showing the same plan, and switching
 * project switches it. Disk is the source of truth — every refresh re-reads the
 * file, so a hand-edit outside Aurora, an app restart, or coming back hours
 * later all resolve correctly with no sync step.
 *
 * Liveness lives here too. A step is only *running* when its `runId` names a
 * thread that is streaming right now; otherwise it is paused. See
 * {@link resolvePlanStepState} — a spinner over a dead runtime is a lie, and
 * that is precisely the case the user hits after stopping a run.
 */

import { create } from "zustand";

import {
  getActivePlan,
  PLAN_CHANGED_EVENT,
  resolvePlanStepState,
  setPlanStatus,
  setPlanStepStatus,
  savePlanBody,
  type PlanChangedEvent,
  type PlanStatus,
  type PlanStepPresentation,
  type PlanStepStatus,
  type PlanView,
} from "@/apps/agent/services/plans/agent-plans";
import { auroraListen, type AuroraUnlistenFn } from "@/kernel/lib/ipc/runtime";

interface AgentPlanState {
  /** Active plan per workspace root. `null` means "checked, none exists". */
  byWorkspace: Record<string, PlanView | null | undefined>;
  loadingByWorkspace: Record<string, boolean | undefined>;
  errorsByWorkspace: Record<string, string | undefined>;
  /** Set to false to stop the Canvas re-opening itself after a manual close. */
  subscribed: boolean;

  refresh: (workspaceRoot: string) => Promise<PlanView | null>;
  setStepStatus: (
    workspaceRoot: string,
    planId: string,
    stepId: string,
    status: PlanStepStatus,
    note?: string,
  ) => Promise<PlanView>;
  saveBody: (
    workspaceRoot: string,
    planId: string,
    body: string,
  ) => Promise<PlanView>;
  setStatus: (
    workspaceRoot: string,
    planId: string,
    status: PlanStatus,
  ) => Promise<PlanView>;
  clearWorkspace: (workspaceRoot: string) => void;
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Map key for a workspace path.
 *
 * Rust reports the path as the tool resolved it and the frontend holds the
 * path the user opened; on Windows those routinely differ in separators and
 * drive-letter case for the *same folder*. Keying on the raw string meant the
 * panel could hold a plan under one spelling and look it up under another, and
 * silently show nothing. Normalising removes that whole class of bug.
 *
 * Only the key is normalised — IPC always receives the original path.
 */
export const workspaceKey = (root: string): string =>
  root.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

export const useAgentPlanStore = create<AgentPlanState>((set) => ({
  byWorkspace: {},
  loadingByWorkspace: {},
  errorsByWorkspace: {},
  subscribed: false,

  refresh: async (workspaceRoot) => {
    if (!workspaceRoot) return null;
    const key = workspaceKey(workspaceRoot);
    set((state) => ({
      loadingByWorkspace: { ...state.loadingByWorkspace, [key]: true },
    }));
    try {
      const plan = await getActivePlan(workspaceRoot);
      set((state) => ({
        byWorkspace: { ...state.byWorkspace, [key]: plan },
        loadingByWorkspace: { ...state.loadingByWorkspace, [key]: false },
        errorsByWorkspace: { ...state.errorsByWorkspace, [key]: undefined },
      }));
      return plan;
    } catch (error) {
      set((state) => ({
        loadingByWorkspace: { ...state.loadingByWorkspace, [key]: false },
        errorsByWorkspace: {
          ...state.errorsByWorkspace,
          [key]: errorMessage(error),
        },
      }));
      return null;
    }
  },

  setStepStatus: async (workspaceRoot, planId, stepId, status, note) => {
    const plan = await setPlanStepStatus(
      workspaceRoot,
      planId,
      stepId,
      status,
      note,
    );
    set((state) => ({
      byWorkspace: { ...state.byWorkspace, [workspaceKey(workspaceRoot)]: plan },
      errorsByWorkspace: {
        ...state.errorsByWorkspace,
        [workspaceKey(workspaceRoot)]: undefined,
      },
    }));
    return plan;
  },

  saveBody: async (workspaceRoot, planId, body) => {
    const plan = await savePlanBody(workspaceRoot, planId, body);
    set((state) => ({
      byWorkspace: { ...state.byWorkspace, [workspaceKey(workspaceRoot)]: plan },
    }));
    return plan;
  },

  setStatus: async (workspaceRoot, planId, status) => {
    const plan = await setPlanStatus(workspaceRoot, planId, status);
    // Closing or abandoning a plan means it is no longer the ACTIVE one, so the
    // panel must fall back to whatever is (usually nothing) rather than keep
    // displaying a plan the workspace has moved on from.
    const stillActive = plan.status === "active" || plan.status === "draft";
    set((state) => ({
      byWorkspace: {
        ...state.byWorkspace,
        [workspaceKey(workspaceRoot)]: stillActive ? plan : null,
      },
    }));
    return plan;
  },

  clearWorkspace: (workspaceRoot) =>
    set((state) => {
      const key = workspaceKey(workspaceRoot);
      const byWorkspace = { ...state.byWorkspace };
      const loadingByWorkspace = { ...state.loadingByWorkspace };
      const errorsByWorkspace = { ...state.errorsByWorkspace };
      delete byWorkspace[key];
      delete loadingByWorkspace[key];
      delete errorsByWorkspace[key];
      return { byWorkspace, loadingByWorkspace, errorsByWorkspace };
    }),
}));

/**
 * Window-lifetime subscription to `agent_plan_changed`, so a step flipping to
 * `in_progress` reaches the Canvas immediately rather than on the next poll.
 *
 * Deliberately **never torn down**. The Canvas is a dock tab that mounts and
 * unmounts as the user switches tabs; unlistening on unmount would mean a plan
 * that changed while the tab was closed is missed, and re-subscribing on every
 * mount risks stacking duplicate listeners. One listener for the life of the
 * window is both simpler and correct — the handler only triggers a re-read.
 *
 * The payload carries no plan content on purpose: the file is the source of
 * truth, so a stale event can never produce stale content.
 */
let planSubscription: Promise<AuroraUnlistenFn | undefined> | undefined;

/**
 * Reveal the Canvas when a plan is authored.
 *
 * Imported lazily because the workspace store pulls in the dock's component
 * graph; a static import here would create a cycle back through CanvasPanel.
 */
const openCanvasForPlan = async (): Promise<void> => {
  try {
    const { useAgentWorkspaceStore } = await import("@/apps/agent/store/workspace/useAgentWorkspaceStore");
    useAgentWorkspaceStore.getState().openTab("canvas");
  } catch {
    // The dock is unavailable (tests, web preview). The plan is still on disk
    // and the panel shows it whenever the user opens the tab themselves.
  }
};

export const subscribeToPlanChanges = (): Promise<
  AuroraUnlistenFn | undefined
> => {
  if (planSubscription) return planSubscription;
  planSubscription = auroraListen<PlanChangedEvent>(
    PLAN_CHANGED_EVENT,
    ({ payload }) => {
      if (!payload) return;
      const store = useAgentPlanStore.getState();

      // Refresh the payload's workspace AND every workspace already on screen.
      // Rust reports the path as the tool resolved it, which can differ from
      // the frontend's own string for the same folder (separators, casing,
      // canonicalisation). Keying purely off the payload would silently miss
      // the panel the user is actually looking at, so treat the event as a
      // trigger rather than an address.
      const roots = new Set<string>(Object.keys(store.byWorkspace));
      if (payload.workspaceRoot) roots.add(payload.workspaceRoot);
      for (const root of roots) void store.refresh(root);

      // A newly authored plan opens the Canvas; progress updates never do.
      if (payload.reason === "authored") {
        void openCanvasForPlan();
      }
    },
  )
    .then((unlisten) => {
      useAgentPlanStore.setState({ subscribed: true });
      return unlisten;
    })
    .catch(() => {
      // No Tauri runtime (web preview / tests). The panel still works — it
      // refreshes when opened and after each action, just not live. Clearing
      // the cached promise lets a later attempt succeed.
      planSubscription = undefined;
      return undefined;
    });
  return planSubscription;
};

/**
 * Presentation state for every step, with liveness already applied.
 *
 * `liveThreadIds` is the set of threads currently streaming — a step claimed by
 * a thread outside that set is paused, not running.
 */
export const presentPlanSteps = (
  plan: PlanView,
  liveThreadIds: ReadonlySet<string>,
): Map<string, PlanStepPresentation> => {
  const isRunLive = (runId: string) => liveThreadIds.has(runId);
  return new Map(
    plan.steps.map((step) => [step.id, resolvePlanStepState(step, isRunLive)]),
  );
};
