/**
 * The live tail under an agent's row: a token streaming into its newest line
 * must not re-draw the tool cards above it.
 *
 * On 2026-10-09 four open tails re-rendered every one of their rows (up to
 * 150 tool cards each) on every streamed event, because the steps were
 * rebuilt as new objects each time. This counts tool-card renders across a
 * stream of rebuilt transcripts.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SubagentTail } from "@/apps/agent/components/panels/SubagentTail";
import type { SubagentTranscript } from "@/apps/agent/hooks/subagents/useSubagentTranscript";
import type { DbMessage } from "@/apps/agent/services/threads/thread-service";

const toolCardRenders = vi.fn();

vi.mock("@/apps/agent/components/tools/ToolCallCard", () => ({
  ToolCallCard: ({ call }: { call: { id: string } }) => {
    toolCardRenders(call.id);
    return <div data-tool={call.id} />;
  },
}));

vi.mock("@/apps/agent/shared/AgentIcon", () => ({
  AgentIcon: () => null,
}));

vi.mock("@/apps/agent/hooks/conversation/useAgentAutoScroll", () => ({
  useAgentAutoScroll: () => ({
    containerRef: { current: null },
    contentRef: { current: null },
    jumpToBottom: () => {},
  }),
}));

let transcript: SubagentTranscript;
vi.mock("@/apps/agent/hooks/subagents/useSubagentTranscript", () => ({
  useSubagentTranscript: () => transcript,
}));

const at = "2026-10-09T03:00:00Z";

/** A fresh transcript every call: new arrays, new objects, same content. */
const messagesWith = (liveText: string, c2Result: string | null = "ok"): DbMessage[] => [
  {
    id: "a1",
    role: "assistant",
    content: "",
    timestamp: at,
    timeline: [
      { kind: "tool", id: "c1", call: { id: "c1", name: "file_read", arguments: "{}", result: "ok" } },
      { kind: "tool", id: "c2", call: { id: "c2", name: "grep", arguments: "{}", result: c2Result } },
    ],
  },
  {
    id: "live-1",
    role: "assistant",
    content: liveText,
    timestamp: at,
    timeline: [{ kind: "content", id: "k1", text: liveText }],
  },
];

const withMessages = (messages: DbMessage[]): SubagentTranscript => ({
  agent: undefined,
  running: true,
  messages,
  loading: false,
  missing: false,
  pending: [],
});

describe("SubagentTail", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  const render = async () => {
    await act(async () => {
      root ??= createRoot(container);
      root.render(
        <SubagentTail
          parentThreadId="parent-1"
          agentId="a1"
          label="fixer"
          more={false}
          onMoreChange={() => {}}
        />,
      );
    });
  };

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
      .IS_REACT_ACT_ENVIRONMENT = true;
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
    container = document.createElement("div");
    document.body.appendChild(container);
    toolCardRenders.mockClear();
    transcript = withMessages(messagesWith("Readi"));
  });

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
    });
    root = null;
    container.remove();
  });

  it("re-renders only the line that streams, never the finished tool cards", async () => {
    await render();
    expect(toolCardRenders.mock.calls.map((c) => c[0])).toEqual(["c1", "c2"]);
    expect(container.textContent).toContain("Readi");

    // Twenty rebuilt transcripts, the way a stream delivers them.
    for (let i = 0; i < 20; i += 1) {
      transcript = withMessages(messagesWith(`Reading the file ${"a".repeat(i)}`));
      await render();
    }
    expect(container.textContent).toContain("Reading the file aaaaaaaaaaaaaaaaaaa");
    expect(toolCardRenders).toHaveBeenCalledTimes(2);
  });

  it("re-renders a tool card when its own call changes", async () => {
    await render();
    toolCardRenders.mockClear();

    transcript = withMessages(messagesWith("Reading", null));
    await render();
    expect(toolCardRenders.mock.calls.map((c) => c[0])).toEqual(["c2"]);
  });
});
