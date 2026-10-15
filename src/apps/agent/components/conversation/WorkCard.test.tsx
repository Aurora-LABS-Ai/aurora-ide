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

describe("WorkCard", () => {
  it("running and closed: a window of the newest rows, the reply standing still", () => {
    const el = mount(<WorkCard stretch={stretch} live isLast threadId="t" renderItem={renderItem} />);
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
    expect(window.querySelector(".agw-wc-window-in")!.hasAttribute("inert")).toBe(true);
  });

  it("open: every row as the transcript draws it, each one still its own control", () => {
    const el = mount(<WorkCard stretch={stretch} live isLast threadId="t" renderItem={renderItem} />);
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
    const el = mount(<WorkCard stretch={stretch} live={false} isLast={false} threadId="t" renderItem={renderItem} />);
    expect(el.querySelector(".agw-wc-window")).toBeNull();
    expect(el.querySelector(".agw-wc-body")).toBeNull();
    expect(el.querySelector(".agw-wc-head")!.textContent).toContain("Worked");
    expect(el.querySelector(".agw-wc-head")!.textContent).toContain("2 files read · 1 command");
  });

  it("saves an opened card with its conversation, keyed by the first tool call", async () => {
    const el = mount(<WorkCard stretch={stretch} live={false} isLast threadId="thread-9" renderItem={renderItem} />);
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
    const el = mount(<WorkCard stretch={stretch} live={false} isLast threadId="thread-3" renderItem={renderItem} />);
    await act(async () => {
      await useAgentWorkCardStore.getState().hydrate("thread-3");
    });
    expect(el.querySelector(".agw-wc-body")).not.toBeNull();
  });
});
