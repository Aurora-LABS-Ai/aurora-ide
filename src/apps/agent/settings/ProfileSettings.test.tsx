import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProfileSettings } from "./ProfileSettings";

const ipc = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn(), dispose: vi.fn() }));
vi.mock("@/kernel/lib/ipc/runtime", () => ({ auroraInvoke: ipc.invoke, auroraListen: ipc.listen }));
vi.mock("@/apps/agent/store/settings/useAgentSettingsStore", () => ({
  useAgentSettingsStore: (select: (state: { models: never[]; providers: never[] }) => unknown) =>
    select({ models: [], providers: [] }),
}));
vi.mock("@/apps/agent/shared/AgentIcon", () => ({ AgentIcon: () => null }));
vi.mock("./primitives", () => ({
  AgwSegmented: () => null,
  AgwButton: (props: { children: React.ReactNode; disabled?: boolean; onClick?: () => void }) =>
    <button disabled={props.disabled} onClick={props.onClick}>{props.children}</button>,
}));

const stats = (input: number) => ({
  userName: "Local user", totalThreads: 3, totalMessages: 5,
  lifetimeInputTokens: input, lifetimeOutputTokens: 2, lifetimeCacheReadTokens: 0,
  days: [], models: [], unattributed: { requests: 0, tokens: 0 }, requestsByProvider: [],
  totalRequests: 1,
});

describe("Profile permanent usage", () => {
  let host: HTMLDivElement;
  let root: Root | null = null;
  const cleanup = () => { act(() => root?.unmount()); root = null; };
  const render = (view: React.ReactNode) => {
    act(() => { root = createRoot(host); root.render(view); });
  };
  const lifetime = () => [...host.querySelectorAll(".agw-profile-fact")]
    .find((tile) => tile.textContent?.includes("Lifetime tokens"))?.textContent;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    vi.useFakeTimers();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.clearAllMocks();
    ipc.listen.mockResolvedValue(ipc.dispose);
  });
  afterEach(() => { cleanup(); host.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });

  it("refreshes lifetime usage when requests finish without reopening Settings", async () => {
    ipc.invoke.mockResolvedValue(stats(10));
    render(<ProfileSettings />);
    await act(async () => { await vi.advanceTimersByTimeAsync(350); });
    expect(lifetime()).toContain("12");
    expect(ipc.listen).toHaveBeenCalledWith("usage-updated", expect.any(Function));
    ipc.invoke.mockResolvedValue(stats(20));
    act(() => ipc.listen.mock.calls[0][1]());
    await act(async () => { await vi.advanceTimersByTimeAsync(350); });
    expect(lifetime()).toContain("22");
    cleanup();
    expect(ipc.dispose).toHaveBeenCalledTimes(1);
  });

  it("queues a fresh read when usage changes during the initial import", async () => {
    let finish!: (value: ReturnType<typeof stats>) => void;
    ipc.invoke.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    ipc.invoke.mockResolvedValue(stats(30));
    render(<ProfileSettings />);
    await act(async () => { await vi.advanceTimersByTimeAsync(350); });
    expect(ipc.invoke).toHaveBeenCalledTimes(1);
    act(() => ipc.listen.mock.calls[0][1]());
    await act(async () => { await vi.advanceTimersByTimeAsync(350); });
    expect(ipc.invoke).toHaveBeenCalledTimes(1);
    await act(async () => { finish(stats(10)); });
    expect(ipc.invoke).toHaveBeenCalledTimes(2);
    expect(lifetime()).toContain("32");
  });

  it("recovers from an import error on refresh and keeps missing attribution explicit", async () => {
    ipc.invoke.mockRejectedValue(new Error("Historical usage import failed"));
    render(<ProfileSettings />);
    await act(async () => { await vi.advanceTimersByTimeAsync(350); });
    expect(host.textContent).toContain("Historical usage import failed");
    ipc.invoke.mockResolvedValue({ ...stats(40), unattributed: { requests: 1, tokens: 42 } });
    act(() => window.dispatchEvent(new Event("focus")));
    await act(async () => { await vi.advanceTimersByTimeAsync(350); });
    expect(host.textContent).not.toContain("Historical usage import failed");
    // Usage with no recorded model is stated, never ranked as if it were a model.
    expect(host.querySelector(".agw-profile-foot")?.textContent).toContain(
      "recorded before Aurora saved which model answered",
    );
    expect(host.querySelectorAll(".agw-profile-rank")).toHaveLength(0);
  });

  it("caps each list at six and folds removed providers into one row", async () => {
    const providerRow = (providerId: string, requests: number) => ({
      providerId, requests, estimatedRequests: 0, inputTokens: requests, outputTokens: 0,
      cacheReadTokens: 0, threads: 1, models: [],
    });
    ipc.invoke.mockResolvedValue({
      ...stats(40),
      // The mocked store knows no providers, so all eight read as removed:
      // the panel must not list a single id.
      requestsByProvider: Array.from({ length: 8 }, (_, i) => providerRow(`gone-${i}`, 10 - i)),
      models: Array.from({ length: 9 }, (_, i) => ({
        model: `model-${i}`, providers: ["a"], requests: 1, tokens: 100 - i,
      })),
    });
    render(<ProfileSettings />);
    await act(async () => { await vi.advanceTimersByTimeAsync(350); });
    const panels = host.querySelectorAll(".agw-profile-panel");
    expect(panels[0].querySelectorAll(".agw-profile-rank")).toHaveLength(6);
    expect(panels[0].textContent).toContain("All 9 models");
    expect(panels[1].querySelectorAll(".agw-profile-rank")).toHaveLength(0);
    expect(host.textContent).not.toContain("gone-");
    expect(host.querySelector(".agw-profile-foot")?.textContent).toContain("8 providers you've removed");
  });
});
