/**
 * The sub-agent report card (probe: aurora-subagent-report-designs.html,
 * round 3 B). It used to sit on the right in the user bubble's fill — reading
 * as the user's own message — with the summary in one block and the report in
 * a second one behind an "Open report" link. Now it is one card in the agent's
 * column: a top row, and ONE text area holding the summary and the report.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AgentReportCard } from "@/apps/agent/components/conversation/AgentReportCard";
import type { AgentReportEvent } from "@/apps/agent/components/conversation/timeline";
import { useAgentChatStore } from "@/apps/agent/store/conversation/useAgentChatStore";
import { useAgentWorkspaceStore } from "@/apps/agent/store/workspace/useAgentWorkspaceStore";

vi.mock("@/kernel/lib/ipc/runtime", () => ({
  auroraInvoke: vi.fn(),
  auroraListen: vi.fn(() => Promise.resolve(() => {})),
}));

vi.mock("@/apps/agent/shared/AgentIcon", () => ({
  AgentIcon: () => null,
}));

/** The envelope shape a finished sub-agent hands its parent. */
const report: AgentReportEvent = {
  kind: "agent_report",
  id: "r1",
  agentId: "agent_d9",
  name: "home-server",
  status: "completed",
  summary: 'Finished "Server-render home sections" · completed',
  detail: [
    '<subagent_report agent="home-server (agent_d9)" type="general-purpose" status="completed" outcome="done">',
    'Sub-agent "Server-render home sections" completed after 7m 55s · 80 tool calls · 252023 tokens.',
    "Outcome: done",
    "Summary: Home sections are now server-rendered.",
    "",
    "Report:",
    "# Home page: server-side data loading",
    "",
    "## Environment note",
    "node_modules did not exist, so I ran bun install.",
    "</subagent_report>",
  ].join("\n"),
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function draw(element: React.ReactElement): Promise<HTMLDivElement> {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  // jsdom has no ResizeObserver; the card watches its text area with one to
  // decide whether there is more to open.
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(element));
  return container;
}

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe("AgentReportCard", () => {
  it("holds the summary and the report in one text area", async () => {
    const el = await draw(<AgentReportCard report={report} />);

    const areas = el.querySelectorAll(".agw-agent-card-text");
    expect(areas).toHaveLength(1);
    const text = areas[0].textContent ?? "";
    // Summary first, the report straight after it, in the same area.
    expect(text.indexOf("Home sections are now server-rendered.")).toBeGreaterThanOrEqual(0);
    expect(text.indexOf("Home page: server-side data loading")).toBeGreaterThan(
      text.indexOf("Home sections are now server-rendered."),
    );
  });

  it("opens from its top row, with no Open report link and no second block", async () => {
    const el = await draw(<AgentReportCard report={report} />);

    expect(el.textContent).not.toContain("Open report");
    expect(el.querySelector(".agw-agent-card-body")).toBeNull();
    expect(el.querySelector(".agw-agent-card-foot")).toBeNull();
    expect(el.querySelector(".agw-agent-card-toggle")).not.toBeNull();
    // The numbers ride on the top row.
    expect(el.querySelector(".agw-agent-card-head")?.textContent).toContain("80 tool calls");
    expect(el.querySelector(".agw-agent-card-head")?.textContent).toContain("finished");
  });

  it("keeps the agent's name as its own link to the agent's tab", async () => {
    useAgentChatStore.setState({ currentThreadId: "parent-1" });
    const openAgentTab = vi.fn();
    useAgentWorkspaceStore.setState({ openAgentTab });
    const el = await draw(<AgentReportCard report={report} />);

    await act(async () => {
      (el.querySelector(".agw-agent-name") as HTMLButtonElement).click();
    });

    expect(openAgentTab).toHaveBeenCalledWith("parent-1", "agent_d9", "home-server");
  });
});
