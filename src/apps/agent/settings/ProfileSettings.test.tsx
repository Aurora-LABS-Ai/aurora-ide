import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProfileSettings } from "./ProfileSettings";

const ipc = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn(), dispose: vi.fn() }));
vi.mock("@/kernel/lib/ipc/runtime", () => ({ auroraInvoke: ipc.invoke, auroraListen: ipc.listen }));
vi.mock("@/apps/agent/store/settings/useAgentSettingsStore", () => ({
  useAgentSettingsStore: (select: (state: { models: never[]; providers: Array<{ id: string; name: string }> }) => unknown) =>
    select({ models: [], providers: [{ id: "kenari", name: "Kenari" }] }),
}));
vi.mock("@/apps/agent/shared/AgentIcon", () => ({ AgentIcon: () => null }));
vi.mock("./primitives", () => ({
  AgwSegmented: (props: { options: Array<{ value: string; label: string }>; onChange: (v: string) => void }) => (
    <div>
      {props.options.map((o) => (
        <button key={o.value} data-seg={o.value} onClick={() => props.onChange(o.value)}>{o.label}</button>
      ))}
    </div>
  ),
  AgwButton: (props: { children: React.ReactNode; disabled?: boolean; onClick?: () => void }) =>
    <button disabled={props.disabled} onClick={props.onClick}>{props.children}</button>,
}));

const stats = (input: number) => ({
  userName: "Local user", totalThreads: 3, totalMessages: 5,
  lifetimeInputTokens: input, lifetimeOutputTokens: 2, lifetimeCacheReadTokens: 0,
  days: [], models: [], unattributed: { requests: 0, tokens: 0 }, requestsByProvider: [],
  totalRequests: 1, topTools: [], hourOfWeek: [], projects: [],
  cost: { usd: 0, pricedRequests: 0, reportedRequests: 0 },
});

const model = (i: number) => ({
  model: `model-${i}`, providers: ["kenari"], requests: 1, tokens: 100 - i, inputTokens: 90 - i,
  outputTokens: 10, cacheReadTokens: 0, costUsd: 0, pricedRequests: 0,
});

describe("Profile permanent usage", () => {
  let host: HTMLDivElement;
  let root: Root | null = null;
  const cleanup = () => { act(() => root?.unmount()); root = null; };
  const render = (view: React.ReactNode) => {
    act(() => { root = createRoot(host); root.render(view); });
  };
  const settle = () => act(async () => { await vi.advanceTimersByTimeAsync(350); });
  const fact = (label: string) => [...host.querySelectorAll(".agw-profile-fact")]
    .find((tile) => tile.textContent?.includes(label))?.textContent;
  const rows = () => host.querySelectorAll(".agw-profile-tbody .agw-profile-row");
  const click = (el: Element | null | undefined) => act(() => { (el as HTMLElement).click(); });
  const button = (text: string) => [...host.querySelectorAll("button")].find((b) => b.textContent?.includes(text));

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    vi.useFakeTimers();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    vi.clearAllMocks();
    ipc.listen.mockResolvedValue(ipc.dispose);
  });
  afterEach(() => { cleanup(); host.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });

  it("refreshes lifetime usage when requests finish without reopening Settings", async () => {
    ipc.invoke.mockResolvedValue(stats(10));
    render(<ProfileSettings />);
    await settle();
    expect(fact("Billed tokens")).toContain("12");
    expect(ipc.listen).toHaveBeenCalledWith("usage-updated", expect.any(Function));
    ipc.invoke.mockResolvedValue(stats(20));
    act(() => ipc.listen.mock.calls[0][1]());
    await settle();
    expect(fact("Billed tokens")).toContain("22");
    cleanup();
    expect(ipc.dispose).toHaveBeenCalledTimes(1);
  });

  it("queues a fresh read when usage changes during the initial import", async () => {
    let finish!: (value: ReturnType<typeof stats>) => void;
    ipc.invoke.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    ipc.invoke.mockResolvedValue(stats(30));
    render(<ProfileSettings />);
    await settle();
    expect(ipc.invoke).toHaveBeenCalledTimes(1);
    act(() => ipc.listen.mock.calls[0][1]());
    await settle();
    expect(ipc.invoke).toHaveBeenCalledTimes(1);
    await act(async () => { finish(stats(10)); });
    expect(ipc.invoke).toHaveBeenCalledTimes(2);
    expect(fact("Billed tokens")).toContain("32");
  });

  it("recovers from an import error and keeps missing attribution out of the lists", async () => {
    ipc.invoke.mockRejectedValue(new Error("Historical usage import failed"));
    render(<ProfileSettings />);
    await settle();
    expect(host.textContent).toContain("Historical usage import failed");
    ipc.invoke.mockResolvedValue({ ...stats(40), unattributed: { requests: 1, tokens: 42 } });
    act(() => window.dispatchEvent(new Event("focus")));
    await settle();
    expect(host.textContent).not.toContain("Historical usage import failed");
    // Usage with no recorded model is stated, never ranked as if it were a model.
    expect(host.querySelector(".agw-profile-sources")?.textContent).toContain("Before Aurora saved which model answered");
    expect(rows()).toHaveLength(0);
  });

  it("keeps the last stats on screen when a later refresh fails", async () => {
    ipc.invoke.mockResolvedValue(stats(10));
    render(<ProfileSettings />);
    await settle();
    ipc.invoke.mockRejectedValue(new Error("database is locked"));
    act(() => window.dispatchEvent(new Event("focus")));
    await settle();
    expect(fact("Billed tokens")).toContain("12");
    expect(host.querySelector(".agw-set-notice")?.textContent).toContain("database is locked");
  });

  it("shows ten rows, then the whole list inside its own scroller", async () => {
    ipc.invoke.mockResolvedValue({ ...stats(40), models: Array.from({ length: 14 }, (_, i) => model(i)) });
    render(<ProfileSettings />);
    await settle();
    const body = host.querySelector(".agw-profile-tbody")!;
    expect(rows()).toHaveLength(10);
    expect(body.hasAttribute("data-scrolling")).toBe(false);
    click(button("Show all 14 models"));
    // Every row, in a body that scrolls on its own instead of growing the page.
    expect(rows()).toHaveLength(14);
    expect(body.hasAttribute("data-scrolling")).toBe(true);
    click(button("Show top 10"));
    expect(rows()).toHaveLength(10);
  });

  it("folds removed providers into one row and never prints their ids", async () => {
    const providerRow = (providerId: string, requests: number) => ({
      providerId, requests, estimatedRequests: 0, inputTokens: requests, outputTokens: 0,
      cacheReadTokens: 0, threads: 1, models: [],
    });
    ipc.invoke.mockResolvedValue({
      ...stats(40),
      requestsByProvider: [providerRow("kenari", 50), ...Array.from({ length: 3 }, (_, i) => providerRow(`gone-${i}`, 10 - i))],
    });
    render(<ProfileSettings />);
    await settle();
    click(host.querySelector('[data-seg="providers"]'));
    const names = [...rows()].map((r) => r.querySelector(".agw-profile-name")?.textContent);
    expect(names).toEqual(["Kenari", "3 removed providers"]);
    expect(host.textContent).not.toContain("gone-");
  });

  it("states cost only for priced requests and says how many those are", async () => {
    ipc.invoke.mockResolvedValue({ ...stats(40), totalRequests: 4, cost: { usd: 12.5, pricedRequests: 2, reportedRequests: 0 } });
    render(<ProfileSettings />);
    await settle();
    // Whole dollars from $10 up; cents only below that.
    expect(fact("Cost at list prices")).toContain("$13");
    expect(fact("Cost at list prices")).toContain("50% priced");
    expect(fact("Cost at list prices")).toContain("2 of 4 requests have a price");

    ipc.invoke.mockResolvedValue(stats(40));
    act(() => window.dispatchEvent(new Event("focus")));
    await settle();
    // No price anywhere is "—", never "$0".
    expect(fact("Cost at list prices")).not.toContain("$");
    expect(fact("Cost at list prices")).toContain("Set prices on your models");
  });
});
