/**
 * The reasoning block's auto-expand must never lock the toggle.
 *
 * A live "Thinking…" segment opens itself, which is the right default — but the
 * moment the dump is long enough to bury the conversation, the user has to be
 * able to fold it away WHILE it is still streaming. An earlier version derived
 * `expanded` as `isGenerating || manuallyExpanded`, so every click during
 * reasoning was overruled on the next render and the chevron did nothing.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AgentThinkingBlock } from "./AgentThinkingBlock";

describe("AgentThinkingBlock", () => {
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

  const render = (props: { content: string; isGenerating?: boolean; startedAt?: number }) => {
    act(() => {
      root ??= createRoot(container);
      root.render(<AgentThinkingBlock {...props} />);
    });
  };

  const toggle = () => container.querySelector<HTMLButtonElement>(".agw-think-toggle")!;
  const body = () => container.querySelector<HTMLElement>(".agw-think-body");

  it("collapses a segment that is still streaming", () => {
    render({ content: "reasoning…", isGenerating: true, startedAt: Date.now() });

    // Auto-expanded while reasoning — the default.
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    expect(body()).not.toBeNull();

    act(() => toggle().click());

    // The click wins over the auto-expand, mid-stream.
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    // Still reasoning, so the header keeps saying so even with the text hidden.
    expect(toggle().textContent).toContain("Thinking…");
  });

  it("keeps it collapsed as more reasoning streams in", () => {
    render({ content: "one", isGenerating: true, startedAt: Date.now() });
    act(() => toggle().click());
    expect(toggle().getAttribute("aria-expanded")).toBe("false");

    // A re-render per streamed frame must not undo the user's choice.
    render({ content: "one two three", isGenerating: true, startedAt: Date.now() });
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
  });

  it("re-opens on a second click while still streaming", () => {
    render({ content: "reasoning…", isGenerating: true, startedAt: Date.now() });
    act(() => toggle().click());
    act(() => toggle().click());

    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    expect(body()).not.toBeNull();
  });

  it("still collapses on its own once reasoning settles", () => {
    render({ content: "reasoning…", isGenerating: true, startedAt: Date.now() });
    expect(toggle().getAttribute("aria-expanded")).toBe("true");

    // Untouched by the user, so the automatic behaviour still applies.
    render({ content: "reasoning…", isGenerating: false });
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(toggle().textContent).toContain("Thought");
  });
});
