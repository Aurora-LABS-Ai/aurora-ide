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

// Markdown needs the theme store, not a live settings/database bootstrap.
vi.mock("@/apps/agent/store/settings/useAgentSettingsStore", () => ({
  useAgentSettingsStore: { getState: () => ({ providers: [], selectedModel: null }) },
}));

import { AgentMarkdown } from "./AgentMarkdown";
import { useAgentThemeStore } from "@/apps/agent/store/ui/useAgentThemeStore";
import { REPLY_LAYOUT_EXAMPLES, UI_PROMPT_LINES } from "@/apps/agent/lib/reply-layout/instructions";

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
    useAgentThemeStore.setState({ transcriptReplyLayout: false, transcriptTextPace: "steady" });
  });

  const render = async (content = REPLY, streaming = false, answerBoxes = true) => {
    await act(async () => {
      root ??= createRoot(container);
      root.render(<AgentMarkdown content={content} streaming={streaming} answerBoxes={answerBoxes} />);
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

  it.each(["compare", "checklist", "timeline", "tree"] as const)(
    "draws %s with the setting on and switches the same reply back to code", async (kind) => {
      const content = `Before.\n\n\`\`\`aurora-${kind}\n${REPLY_LAYOUT_EXAMPLES[kind]}\n\`\`\`\n\nAfter.`;
      useAgentThemeStore.setState({ transcriptReplyLayout: true });
      await render(content);
      expect(container.querySelector(`.agw-rl-wrap[data-kind="${kind}"]`)).not.toBeNull();
      expect(container.textContent).toContain("Before.");
      expect(container.textContent).toContain("After.");
      act(() => useAgentThemeStore.setState({ transcriptReplyLayout: false }));
      expect(container.querySelector(".agw-rl-wrap")).toBeNull();
      expect(container.querySelector("pre, code")).not.toBeNull();
      expect(container.textContent).toContain(REPLY_LAYOUT_EXAMPLES[kind].split("\n")[1]);
    },
  );

  it("keeps structured fences as code outside the transcript", async () => {
    useAgentThemeStore.setState({ transcriptReplyLayout: true });
    await render(`\`\`\`aurora-tree\n${REPLY_LAYOUT_EXAMPLES.tree}\n\`\`\``, false, false);
    expect(container.querySelector(".agw-rl-wrap")).toBeNull();
    expect(container.querySelector("pre, code")).not.toBeNull();
  });

  it("finishes an unclosed layout when the turn stops", async () => {
    useAgentThemeStore.setState({ transcriptReplyLayout: true, transcriptTextPace: "instant" });
    await render("```aurora-checklist\nRelease\ndone | Build", true);
    expect(container.querySelector(".agw-rl-status-row")).toBeNull();
    await render("```aurora-checklist\nRelease\ndone | Build");
    expect(container.querySelector(".agw-rl-status-row")?.textContent).toContain("Build");
  });

  it("draws an aurora-ui layout between prose with the setting on, and code with it off", async () => {
    useAgentThemeStore.setState({ transcriptReplyLayout: true });
    const lines = UI_PROMPT_LINES.join("\n");
    await render(`Here is the shape of it.\n\n\`\`\`aurora-ui\n${lines}\n\`\`\`\n\nThat is all.`);
    expect(container.querySelector('.agw-rl-wrap[data-kind="ui"]')).not.toBeNull();
    expect(container.querySelectorAll(".agw-rl-fact")).toHaveLength(2);
    expect(container.querySelector(".agw-rl-ui-heading")?.textContent).toBe("Request");
    expect(container.querySelector(".agw-rl-note-title")?.textContent).toBe("Not verified");
    expect(container.textContent).toContain("Here is the shape of it.");
    expect(container.textContent).toContain("That is all.");
    expect(container.textContent).not.toContain("root = Page");
    act(() => useAgentThemeStore.setState({ transcriptReplyLayout: false }));
    expect(container.querySelector(".agw-rl-ui")).toBeNull();
    expect(container.textContent).toContain("root = Page");
  });

  it("draws a streaming aurora-ui layout part by part", async () => {
    useAgentThemeStore.setState({ transcriptReplyLayout: true, transcriptTextPace: "instant" });
    await render(`\`\`\`aurora-ui\n${UI_PROMPT_LINES.slice(0, 2).join("\n")}\n${UI_PROMPT_LINES[2].slice(0, 30)}`, true);
    expect(container.querySelectorAll(".agw-rl-fact")).toHaveLength(2);
    expect(container.querySelector(".agw-rl-flow")).toBeNull();
    expect(container.querySelector(".agw-rl-problems")).toBeNull();
  });

  it("renders a connected report inside prose and returns it to code when disabled", async () => {
    useAgentThemeStore.setState({ transcriptReplyLayout: true });
    const source = `The supplied report totals follow.\n\n\`\`\`aurora-report\n${REPLY_LAYOUT_EXAMPLES.report}\n\`\`\`\n\nAll amounts are USD.`;
    await render(source);
    expect(container.querySelector(".ac-report .ac-metric-value")?.textContent).toBe("$17.9138");
    expect(container.querySelectorAll(".ac-plot-mark")).toHaveLength(5);
    expect(container.textContent).toContain("All amounts are USD.");
    act(() => useAgentThemeStore.setState({ transcriptReplyLayout: false }));
    expect(container.querySelector(".ac-report")).toBeNull();
    expect(container.querySelector("pre, code")).not.toBeNull();
  });
});
