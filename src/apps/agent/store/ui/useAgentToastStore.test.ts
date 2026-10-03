import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MAX_TOASTS, TOAST_DURATION_MS, toast, useAgentToastStore } from "./useAgentToastStore";

beforeEach(() => {
  vi.useFakeTimers();
  useAgentToastStore.setState({ toasts: [] });
});
afterEach(() => {
  useAgentToastStore.getState().toasts.forEach((entry) => useAgentToastStore.getState().dismiss(entry.id));
  vi.useRealTimers();
});

const texts = () => useAgentToastStore.getState().toasts.map((entry) => entry.text);

describe("toast", () => {
  it("shows a success toast with a check by default, and clears it on its own", () => {
    toast("Prompt copied");
    expect(useAgentToastStore.getState().toasts[0]).toMatchObject({
      text: "Prompt copied",
      tone: "success",
      icon: "check",
    });
    vi.advanceTimersByTime(TOAST_DURATION_MS);
    expect(texts()).toEqual([]);
  });

  it("ignores empty text", () => {
    expect(toast("   ")).toBe(-1);
    expect(texts()).toEqual([]);
  });

  it("replaces the same words instead of stacking them, with a fresh timer", () => {
    toast("Saved");
    vi.advanceTimersByTime(TOAST_DURATION_MS - 100);
    toast("Saved");
    expect(texts()).toEqual(["Saved"]);
    vi.advanceTimersByTime(200);
    expect(texts()).toEqual(["Saved"]);
  });

  it("keeps at most a few, dropping the oldest", () => {
    for (let i = 0; i <= MAX_TOASTS; i++) toast(`T${i}`);
    expect(texts()).toEqual(["T1", "T2", "T3"].slice(0, MAX_TOASTS));
  });

  it("marks errors with an alert icon and can be dismissed early", () => {
    const id = toast("Could not copy", { tone: "error" });
    expect(useAgentToastStore.getState().toasts[0].icon).toBe("alert");
    useAgentToastStore.getState().dismiss(id);
    expect(texts()).toEqual([]);
  });
});
