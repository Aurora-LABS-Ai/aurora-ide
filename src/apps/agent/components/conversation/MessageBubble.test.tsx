import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MessageBubble } from "@/apps/agent/components/conversation/MessageBubble";
import type { TimelineEvent } from "@/apps/agent/components/conversation/timeline";
import { useAgentThemeStore } from "@/apps/agent/store/ui/useAgentThemeStore";

describe("MessageBubble chapters, bounded (work cards off)", () => {
  /**
   * Alvan, 2026-10-12: a chapter's body becomes a bounded area that scrolls
   * inside itself — and the final answer must NOT end up trapped in the last
   * chapter's box. The chapter stops at the turn's last thought or tool run;
   * the answer renders below it.
   */
  it("keeps the last chapter's steps in the bounded area and the answer outside it", () => {
    const call = (id: string, name: string, args: object) => ({
      id,
      name,
      arguments: JSON.stringify(args),
      result: "ok",
    });
    const events: TimelineEvent[] = [
      { kind: "tool", id: "ch1", call: call("ch1", "chapter", { title: "Read the proxy" }) },
      { kind: "thinking", id: "t1", text: "Check the matchers." },
      { kind: "tool", id: "c1", call: call("c1", "file_read", { path: "src/proxy.ts" }) },
      { kind: "content", id: "answer", text: "THE FINAL ANSWER is here." },
    ];
    const html = renderToStaticMarkup(
      <MessageBubble
        showActions={false}
        message={{ role: "assistant", content: "THE FINAL ANSWER is here." }}
        events={events}
      />,
    );
    const root = document.createElement("div");
    root.innerHTML = html;
    expect(root.querySelector(".agw-wc-body [data-row='tools']")).not.toBeNull();
    expect(root.querySelector(".agw-wc-body [data-row='thinking']")).not.toBeNull();
    // The answer row exists, and is not inside the bounded area.
    expect(root.querySelector("[data-row='content']")).not.toBeNull();
    expect(root.querySelector(".agw-wc-body [data-row='content']")).toBeNull();
  });
});

describe("MessageBubble with work cards on", () => {
  /** Drawn in a real DOM: a store read while rendering to a string sees the
   *  store's initial state, where work cards are off. */
  it("puts narration and an artifact inside one card as plain steps, and the answer below it", () => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    useAgentThemeStore.setState({ transcriptWorkCards: true, reduceMotion: true });
    const call = (id: string, name: string, args: object) => ({ id, name, arguments: JSON.stringify(args), result: "ok" });
    const events: TimelineEvent[] = [
      { kind: "content", id: "intro", text: "Looking at the proxy." },
      { kind: "tool", id: "c1", call: call("c1", "file_read", { path: "src/proxy.ts" }) },
      { kind: "tool", id: "c2", call: call("c2", "file_read", { path: "src/b.ts" }) },
      { kind: "tool", id: "c3", call: call("c3", "file_read", { path: "src/c.ts" }) },
      { kind: "content", id: "mid", text: "Now the picture." },
      { kind: "tool", id: "art", call: call("art", "present_artifact", { artifactId: "x" }) },
      { kind: "content", id: "answer", text: "THE FINAL ANSWER is here." },
    ];
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    try {
      act(() =>
        root.render(
          <MessageBubble
            showActions={false}
            message={{ role: "assistant", content: "THE FINAL ANSWER is here." }}
            events={events}
          />,
        ),
      );
      const card = host.querySelector(".agw-wc")!;
      expect(card).not.toBeNull();
      act(() => card.querySelector<HTMLButtonElement>(".agw-wc-head")!.click());
      const inside = card.querySelectorAll(".agw-wc-rows > [data-row='content']");
      expect(Array.from(inside).map((el) => el.textContent)).toEqual([
        expect.stringContaining("Looking at the proxy."),
        expect.stringContaining("Now the picture."),
      ]);
      // Three reads are three plain steps: no "3 calls" header inside the card.
      expect(card.querySelector(".agw-tool-group-head")).toBeNull();
      expect(card.querySelectorAll(".agw-wc-step").length).toBe(4);
      // The answer is below the card, not in it.
      expect(card.textContent).not.toContain("THE FINAL ANSWER");
      expect(host.textContent).toContain("THE FINAL ANSWER");
    } finally {
      act(() => root.unmount());
      host.remove();
      useAgentThemeStore.setState({ transcriptWorkCards: false, reduceMotion: false });
    }
  });
});

describe("MessageBubble prompt chips", () => {
  it("replays file paths with spaces and slash commands as composer pills", () => {
    const html = renderToStaticMarkup(
      <MessageBubble
        showActions={false}
        message={{
          role: "user",
          content: "Review @src/brand values.tsx",
          attachedPromptChips: [
            {
              kind: "file",
              title: "brand values.tsx",
              value: "src/brand values.tsx",
              path: "E:/work/src/brand values.tsx",
            },
            { kind: "skill", title: "frontend-design" },
          ],
        }}
      />,
    );

    expect(html).toContain("agw-pill-inline");
    expect(html).toContain("agw-pill-cmd");
    expect(html).toContain("brand values.tsx");
    expect(html).toContain("frontend-design");
    expect(html).not.toContain("@src/brand values.tsx");
  });
});
