/**
 * The work card (Transcript → Work cards; probe aurora-work-card-designs.html,
 * 02). What it must do, from Alvan's brief: fold a quiet stretch into one
 * card, keep the reply still while it runs, and when opened show every row as
 * the transcript draws it — each one still opens on its own. Opening is saved
 * with the conversation.
 */

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WorkCard } from "@/apps/agent/components/conversation/WorkCard";
import type { TimelineRow } from "@/apps/agent/components/conversation/timeline";
import { groupWorkStretches, type IndexedRow, type WorkStretch } from "@/apps/agent/components/conversation/work-stretches";
import { useAgentWorkCardStore } from "@/apps/agent/store/conversation/useAgentWorkCardStore";
import { ArrivalHoldContext } from "@/apps/agent/components/tools/arrival-hold";
import { useInLiveWorkCard } from "@/apps/agent/components/conversation/work-card-context";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@/kernel/lib/ipc/runtime", () => ({
  auroraInvoke: invoke,
  auroraListen: vi.fn(() => Promise.resolve(() => {})),
}));
vi.mock("@/apps/agent/shared/AgentIcon", () => ({ AgentIcon: () => null }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const think = (id: string): TimelineRow => ({ type: "thinking", id, text: "…" });
const tools = (id: string, name = "file_read"): TimelineRow => ({
  type: "tools",
  id: `tools-${id}`,
  tools: [{ id, name, arguments: JSON.stringify({ path: "src/app/storefront.ts" }) }],
});

/** Six steps: three thoughts, three calls. */
const stretch = groupWorkStretches([
  think("t1"),
  tools("toolu_1"),
  think("t2"),
  tools("toolu_2", "shell_execute"),
  think("t3"),
  tools("toolu_3"),
])[0] as WorkStretch;

/** Each row is a real control, the way a tool card's header is. */
const renderItem = ({ row }: IndexedRow) => (
  <div key={row.id} className="agw-row">
    <button type="button" data-row-id={row.id}>
      {row.type}
    </button>
  </div>
);

let root: Root | null = null;
let host: HTMLDivElement | null = null;
const mount = (el: React.ReactElement) => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(el));
  return host;
};

beforeEach(() => {
  invoke.mockReset();
  invoke.mockImplementation(async (cmd: string) => (cmd === "agent_work_cards_get" ? { open: [] } : { open: [] }));
  useAgentWorkCardStore.setState({ openByThread: {}, hydrated: {} });
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

describe("WorkCard holds its rows' shape for the whole turn", () => {
  /** A row that reports what the card tells it. */
  const seen: boolean[] = [];
  const Probe: React.FC = () => {
    seen.push(useInLiveWorkCard());
    return null;
  };
  const renderProbeRow = ({ row }: IndexedRow) => <Probe key={row.id} />;

  it("tells its rows the turn is running even when text has lifted out below it", async () => {
    // The card is no longer the live edge (text below it), but the turn runs:
    // its runs must not regroup and fold yet (2026-10-24, "folded asap").
    seen.length = 0;
    const el = mount(<WorkCard stretch={stretch} live={false} turnStreaming isLast={false} threadId={null} renderItem={renderProbeRow} />);
    act(() => (el.querySelector(".agw-wc-head") as HTMLButtonElement).click());
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every(Boolean)).toBe(true);
  });

  it("lets them group once the turn has ended", () => {
    seen.length = 0;
    const el = mount(<WorkCard stretch={stretch} live={false} turnStreaming={false} isLast threadId={null} renderItem={renderProbeRow} />);
    act(() => (el.querySelector(".agw-wc-head") as HTMLButtonElement).click());
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.some(Boolean)).toBe(false);
  });
});

describe("WorkCard", () => {
  it("running and closed: a window of the newest rows, the reply standing still", () => {
    const el = mount(<WorkCard stretch={stretch} live turnStreaming isLast threadId="t" renderItem={renderItem} />);
    const head = el.querySelector(".agw-wc-head")!;
    expect(head.getAttribute("aria-expanded")).toBe("false");
    expect(head.textContent).toContain("Working");
    expect(head.textContent).toContain("3 thoughts · 3 calls");
    const window = el.querySelector(".agw-wc-window")!;
    expect(window).not.toBeNull();
    // The newest rows (up to eight; all six here), in order, kept out of the tab order.
    expect([...window.querySelectorAll("[data-row-id]")].map((b) => b.getAttribute("data-row-id"))).toEqual([
      "t1",
      "tools-toolu_1",
      "t2",
      "tools-toolu_2",
      "t3",
      "tools-toolu_3",
    ]);
    expect(window.querySelector(".agw-wc-rows")!.hasAttribute("inert")).toBe(true);
    // A click anywhere in the window opens the card, as the header does
    // (probe aurora-work-card-click-designs.html, 02). Before, it only lit the
    // header, which read as broken (Alvan, 2026-10-24).
    act(() => (window as HTMLElement).click());
    expect(head.getAttribute("aria-expanded")).toBe("true");
    expect(el.querySelector(".agw-wc-window")).toBeNull();
    expect(el.querySelector(".agw-wc-body")).not.toBeNull();
  });

  /**
   * Alvan, 2026-10-24: the text above the newest row faded out and back in
   * every time an open running card grew. The scroll-linked edge fade flipped
   * under the follow; a running open panel opts out of it (`data-live-panel`),
   * and a finished one keeps it for a reader scrolling by hand.
   */
  it("an open card opts out of the scroll-linked fade only while its stretch runs", () => {
    const el = mount(<WorkCard stretch={stretch} live turnStreaming isLast threadId={null} renderItem={renderItem} />);
    act(() => (el.querySelector(".agw-wc-head") as HTMLButtonElement).click());
    expect(el.querySelector(".agw-wc-body")!.hasAttribute("data-live-panel")).toBe(true);

    act(() => root!.render(<WorkCard stretch={stretch} live={false} turnStreaming={false} isLast threadId={null} renderItem={renderItem} />));
    const body = el.querySelector(".agw-wc-body");
    expect(body).not.toBeNull();
    expect(body!.hasAttribute("data-live-panel")).toBe(false);
  });

  /**
   * Alvan, 2026-10-16: clicking a running card was laggy and jumped. The
   * window and the open panel were two separate trees, so every row was
   * thrown away and built again on the click, and each rebuilt tool step
   * played its arrival from height 0. The rows on screen must survive the
   * click, and the older ones it adds must not count as arriving.
   */
  it("opening a running card keeps the rows on screen and redraws the rest without an arrival", () => {
    const steps: TimelineRow[] = [];
    for (let i = 1; i <= 17; i += 1) steps.push(think(`t${i}`), tools(`toolu_${i}`));
    const long = groupWorkStretches(steps)[0] as WorkStretch;
    const heldAtMount = new Map<string, boolean>();
    const Probe: React.FC<{ id: string }> = ({ id }) => {
      const hold = React.useContext(ArrivalHoldContext);
      React.useState(() => heldAtMount.set(id, hold.current));
      return <button type="button" data-row-id={id} />;
    };
    const renderProbe = ({ row }: IndexedRow) => (
      <div key={row.id} className="agw-row">
        <Probe id={row.id} />
      </div>
    );

    const el = mount(<WorkCard stretch={long} live turnStreaming isLast threadId={null} renderItem={renderProbe} />);
    const newest = el.querySelector("[data-row-id='tools-toolu_17']");
    expect(el.querySelectorAll("[data-row-id]")).toHaveLength(30);
    act(() => (el.querySelector(".agw-wc-head") as HTMLButtonElement).click());

    expect(el.querySelectorAll("[data-row-id]")).toHaveLength(34);
    expect(el.querySelector("[data-row-id='tools-toolu_17']")).toBe(newest);
    // The four older rows mounted on the click, under the hold.
    expect(heldAtMount.get("t1")).toBe(true);
    expect(heldAtMount.get("tools-toolu_2")).toBe(true);

    // A step arriving after the click is a real arrival.
    const more = groupWorkStretches([...steps, think("t18"), tools("toolu_18")])[0] as WorkStretch;
    act(() => root!.render(<WorkCard stretch={more} live turnStreaming isLast threadId={null} renderItem={renderProbe} />));
    expect(heldAtMount.get("tools-toolu_18")).toBe(false);
  });

  it("open: every row as the transcript draws it, each one still its own control", () => {
    const el = mount(<WorkCard stretch={stretch} live turnStreaming isLast threadId="t" renderItem={renderItem} />);
    act(() => (el.querySelector(".agw-wc-head") as HTMLButtonElement).click());
    const body = el.querySelector(".agw-wc-body")!;
    expect(body).not.toBeNull();
    expect(el.querySelector(".agw-wc-window")).toBeNull();
    const rows = body.querySelectorAll("[data-row-id]");
    expect(rows).toHaveLength(6);
    // Not inert anywhere up the tree: the rows inside can be opened.
    for (const row of rows) expect(row.closest("[inert]")).toBeNull();
  });

  it("finished and closed: the header alone, saying how much work it was", () => {
    const el = mount(<WorkCard stretch={stretch} live={false} turnStreaming={false} isLast={false} threadId="t" renderItem={renderItem} />);
    expect(el.querySelector(".agw-wc-window")).toBeNull();
    expect(el.querySelector(".agw-wc-body")).toBeNull();
    expect(el.querySelector(".agw-wc-head")!.textContent).toContain("Worked");
    expect(el.querySelector(".agw-wc-head")!.textContent).toContain("2 files read · 1 command");
  });

  it("saves an opened card with its conversation, keyed by the first tool call", async () => {
    const el = mount(<WorkCard stretch={stretch} live={false} turnStreaming={false} isLast threadId="thread-9" renderItem={renderItem} />);
    await act(async () => {
      await useAgentWorkCardStore.getState().hydrate("thread-9");
    });
    await act(async () => {
      (el.querySelector(".agw-wc-head") as HTMLButtonElement).click();
    });
    expect(invoke).toHaveBeenCalledWith("agent_work_card_set", {
      threadId: "thread-9",
      cardId: "toolu_1",
      open: true,
    });
    expect(el.querySelector(".agw-wc-body")).not.toBeNull();
  });

  it("opens a saved card straight away when the conversation is reopened", async () => {
    invoke.mockImplementation(async (cmd: string) =>
      cmd === "agent_work_cards_get" ? { open: ["toolu_1"] } : { open: ["toolu_1"] },
    );
    const el = mount(<WorkCard stretch={stretch} live={false} turnStreaming={false} isLast threadId="thread-3" renderItem={renderItem} />);
    await act(async () => {
      await useAgentWorkCardStore.getState().hydrate("thread-3");
    });
    expect(el.querySelector(".agw-wc-body")).not.toBeNull();
  });
});
