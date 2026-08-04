import { describe, expect, it } from "vitest";

import { presentPlanSteps } from "./useAgentPlanStore";
import { resolvePlanStepState, type PlanStep, type PlanView } from "../../services/agent-plans";

const step = (over: Partial<PlanStep> & Pick<PlanStep, "id" | "status">): PlanStep => ({
  title: `Step ${over.id}`,
  ...over,
});

const plan = (steps: PlanStep[]): PlanView => ({
  id: "plan_1",
  title: "API Building",
  status: "active",
  createdAt: "2026-07-28T00:00:00Z",
  updatedAt: "2026-07-28T00:00:00Z",
  threadId: "thr_1",
  path: "/ws/.aurora/plans/001-api.aurora.md",
  steps,
  cursor: {
    activeStepId: steps.find((s) => s.status === "in_progress")?.id ?? null,
    nextStepId: steps.find((s) => s.status === "pending")?.id ?? null,
    done: steps.filter((s) => s.status === "done").length,
    failed: 0,
    skipped: 0,
    pending: steps.filter((s) => s.status === "pending").length,
    total: steps.length,
    complete: false,
  },
  overview: "",
  sections: [],
  body: "",
});

describe("plan step liveness", () => {
  it("spins only when the claiming run is actually streaming", () => {
    const running = step({ id: "s1", status: "in_progress", runId: "thr_1" });

    expect(resolvePlanStepState(running, (id) => id === "thr_1")).toBe("running");
    expect(resolvePlanStepState(running, (id) => id === "thr_2")).toBe("paused");
    expect(resolvePlanStepState(running, () => false)).toBe("paused");
  });

  it("treats an in-progress step with no run claim as paused", () => {
    // Hand-edited files and user-set statuses land here. Nothing is executing
    // them, so animating would claim work that is not happening.
    const orphan = step({ id: "s1", status: "in_progress" });
    expect(resolvePlanStepState(orphan, () => true)).toBe("paused");
  });

  it("never animates a closed step, even with a stale run claim", () => {
    for (const status of ["done", "failed", "skipped"] as const) {
      const closed = step({ id: "s1", status, runId: "thr_1" });
      expect(resolvePlanStepState(closed, () => true)).toBe(status);
    }
  });

  it("maps pending straight through", () => {
    expect(resolvePlanStepState(step({ id: "s1", status: "pending" }), () => true)).toBe(
      "pending",
    );
  });

  it("resolves a whole plan against the set of streaming threads", () => {
    const view = plan([
      step({ id: "s1", status: "done" }),
      step({ id: "s2", status: "in_progress", runId: "thr_1" }),
      step({ id: "s3", status: "pending" }),
    ]);

    const live = presentPlanSteps(view, new Set(["thr_1"]));
    expect(live.get("s1")).toBe("done");
    expect(live.get("s2")).toBe("running");
    expect(live.get("s3")).toBe("pending");

    // The user stopped the run, or reopened the app hours later: the same file
    // must now read as paused rather than spinning forever.
    const idle = presentPlanSteps(view, new Set());
    expect(idle.get("s2")).toBe("paused");
    expect(idle.get("s1")).toBe("done");
  });

  it("does not spin for a step claimed by a different conversation", () => {
    const view = plan([step({ id: "s1", status: "in_progress", runId: "thr_other" })]);
    expect(presentPlanSteps(view, new Set(["thr_1"])).get("s1")).toBe("paused");
  });
});
