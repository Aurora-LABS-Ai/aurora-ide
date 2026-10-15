/**
 * Transcript → Reply layout: on, a layout fence in a reply is drawn as its
 * block; off, it is the code block it always was. The switch is the theme
 * store's, read where the reply is drawn.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/apps/agent/services/answer-box/commands", () => ({
  getAnswerBoxes: vi.fn().mockResolvedValue({ boxes: {} }),
  setAnswerBox: vi.fn().mockResolvedValue({ boxes: {} }),
}));

import { AgentMarkdown } from "./AgentMarkdown";
import { useAgentThemeStore } from "@/apps/agent/store/ui/useAgentThemeStore";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const REPLY = ["One gate in front of everything.", "", "```aurora-facts", "Framework | Next.js 16.2.3 | App Router", "Database | PostgreSQL", "```", "", "The rest is prose."].join("\n");

describe("AgentMarkdown with reply layout", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container.remove();
    useAgentThemeStore.setState({ transcriptReplyLayout: false });
  });

  const render = async () => {
    await act(async () => {
      root = createRoot(container);
      root.render(<AgentMarkdown content={REPLY} answerBoxes />);
    });
    return container;
  };

  it("draws the block when the setting is on", async () => {
    useAgentThemeStore.setState({ transcriptReplyLayout: true });
    const el = await render();
    expect(el.querySelectorAll(".agw-rl-fact")).toHaveLength(2);
    expect(el.textContent).toContain("One gate in front of everything.");
    expect(el.textContent).toContain("The rest is prose.");
    expect(el.textContent).not.toContain("```");
  });

  it("leaves it as code when the setting is off", async () => {
    const el = await render();
    expect(el.querySelector(".agw-rl-fact")).toBeNull();
    expect(el.querySelector("pre, code")).not.toBeNull();
    expect(el.textContent).toContain("Framework | Next.js 16.2.3 | App Router");
  });
});
