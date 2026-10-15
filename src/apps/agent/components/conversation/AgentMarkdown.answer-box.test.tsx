/**
 * An `aurora-box` fence is a working box in the transcript and plain code
 * everywhere else. The box saves what the reader sets with the conversation,
 * so a file viewer or a canvas showing the same text must not grow one.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/apps/agent/services/answer-box/commands", () => ({
  getAnswerBoxes: vi.fn().mockResolvedValue({ boxes: {} }),
  setAnswerBox: vi.fn().mockResolvedValue({ boxes: {} }),
}));

import { AgentMarkdown } from "./AgentMarkdown";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const REPLY = [
  "Plan on about **400 g** per person.",
  "",
  "```aurora-box",
  'stepper people "Number of people" 6 min=1 max=30',
  'row "Lamb" = people * 400 g',
  "```",
  "",
  "Shop for one extra if the list might grow.",
].join("\n");

describe("AgentMarkdown with answer boxes", () => {
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
  });

  const render = async (answerBoxes: boolean) => {
    await act(async () => {
      root = createRoot(container);
      root.render(<AgentMarkdown content={REPLY} answerBoxes={answerBoxes} />);
    });
    return container;
  };

  it("draws the box between the two pieces of prose in the transcript", async () => {
    const output = await render(true);
    expect(output.querySelector(".agw-abox")).not.toBeNull();
    expect(output.querySelector(".ac-row-value")?.textContent).toBe("2.4 kg");
    const text = output.textContent ?? "";
    expect(text.indexOf("per person")).toBeLessThan(text.indexOf("Lamb"));
    expect(text.indexOf("Lamb")).toBeLessThan(text.indexOf("Shop for one extra"));
    expect(text).not.toContain("aurora-box");
  });

  it("leaves the fence as code anywhere boxes are not switched on", async () => {
    const output = await render(false);
    expect(output.querySelector(".agw-abox")).toBeNull();
    expect(output.textContent).toContain('row "Lamb" = people * 400 g');
  });
});
