import {
  act,
  createElement,
  forwardRef,
  type PropsWithChildren,
  type ReactElement,
  type ReactNode,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ToolGroup } from "@/apps/agent/components/tools/ToolGroup";
import type { ToolCall } from "@/apps/agent/components/tools/tool-call";
import { useAgentThemeStore } from "@/apps/agent/store/ui/useAgentThemeStore";

vi.mock("@/kernel/store/useSettingsStore", () => ({
  useSettingsStore: (select: (state: { explorerIconPack: string }) => unknown) =>
    select({ explorerIconPack: "material-icon-theme" }),
}));

/** Motion elements render as their plain tag, keeping `className`. */
vi.mock("framer-motion", () => {
  const passthrough = (tag: "div" | "span" | "button") =>
    forwardRef<HTMLElement, Record<string, unknown>>(function Motion(props, ref) {
      const { children, initial, animate, exit, transition, layout, ...rest } = props;
      void initial;
      void animate;
      void exit;
      void transition;
      void layout;
      return createElement(tag, { ...rest, ref }, children as ReactNode);
    });
  return {
    AnimatePresence: ({ children }: PropsWithChildren) => children,
    motion: { div: passthrough("div"), span: passthrough("span"), button: passthrough("button") },
  };
});

const read = (id: string, path: string, done: boolean): ToolCall => ({
  id,
  name: "file_read",
  arguments: JSON.stringify({ path }),
  ...(done ? { result: "1\tpackage wireguard" } : {}),
});

/** The shape of the run that prompted this: one call per model request, the
 *  newest still running. */
const run = [
  read("c1", "internal/tunnel/wireguard/engine_windows.go", true),
  read("c2", "internal/splittunnel/bypass.go", true),
  read("c3", "internal/tunnel/wireguard/splitdevice.go", false),
];

let root: Root | null = null;
let container: HTMLDivElement | null = null;

// Rendered in a real DOM, not to a string: a store read during server
// rendering returns the store's INITIAL state, so the setting would read as off.
async function draw(element: ReactElement): Promise<HTMLDivElement> {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(element));
  return container;
}

/** Re-render the mounted run with new props, as the transcript does when a
 *  result lands, a row lands below it, or the turn ends. */
async function redraw(element: ReactElement): Promise<void> {
  await act(async () => root!.render(element));
}

const done = (calls: ToolCall[]) => calls.map((t) => ({ ...t, result: t.result ?? "ok" }));
const twoCalls = done(run.slice(0, 2));

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  useAgentThemeStore.setState({
    transcriptLiveLine: false,
    transcriptSmoothTools: true,
    transcriptToolRunsOpen: false,
  });
});

describe("Transcript → One live line: what a run becomes after it is live", () => {
  /**
   * 2026-10-12: a two-call run showed as one line while live, then split into
   * two separate rows the moment the model moved on — the one place a run of
   * two could break apart, because two is below the grouping threshold.
   */
  it("folds a two-call run to one header in place when something lands below it", async () => {
    useAgentThemeStore.setState({ transcriptLiveLine: true, transcriptSmoothTools: false });
    const el = await draw(<ToolGroup tools={twoCalls} isActivelyStreaming isLastRow />);
    expect(el.querySelectorAll(".agw-tool-liveline")).toHaveLength(1);

    await redraw(<ToolGroup tools={twoCalls} isActivelyStreaming isLastRow={false} />);

    expect(el.querySelector(".agw-tool-liveline")).toBeNull();
    const heads = el.querySelectorAll(".agw-tool-group-head");
    expect(heads).toHaveLength(1);
    expect(heads[0].getAttribute("aria-expanded")).toBe("false");
    expect(heads[0].textContent).toContain("2 calls · 2 done");
  });

  /** The turn ending is the other handover. The fold delay is still running
   *  then, and must not open the run for its duration. */
  it("stays folded when the turn ends while the fold delay is still running", async () => {
    useAgentThemeStore.setState({ transcriptLiveLine: true, transcriptSmoothTools: true });
    const el = await draw(<ToolGroup tools={twoCalls} isActivelyStreaming isLastRow />);

    await redraw(<ToolGroup tools={twoCalls} isActivelyStreaming={false} isLastRow />);

    expect(el.querySelector(".agw-tool-liveline")).toBeNull();
    expect(el.querySelector(".agw-tool-group-head")?.getAttribute("aria-expanded")).toBe("false");
  });

  it("does not reopen a handed-over run because of Keep tool runs open", async () => {
    useAgentThemeStore.setState({
      transcriptLiveLine: true,
      transcriptSmoothTools: false,
      transcriptToolRunsOpen: true,
    });
    const el = await draw(<ToolGroup tools={done(run)} isActivelyStreaming isLastRow />);

    await redraw(<ToolGroup tools={done(run)} isActivelyStreaming isLastRow={false} />);

    expect(el.querySelector(".agw-tool-group-head")?.getAttribute("aria-expanded")).toBe("false");
  });

  it("leaves a single call as that one row", async () => {
    useAgentThemeStore.setState({ transcriptLiveLine: true, transcriptSmoothTools: false });
    const one = done(run.slice(0, 1));
    const el = await draw(<ToolGroup tools={one} isActivelyStreaming isLastRow />);

    await redraw(<ToolGroup tools={one} isActivelyStreaming isLastRow={false} />);

    expect(el.querySelector(".agw-tool-group-head")).toBeNull();
    expect(el.querySelectorAll(".agw-tool-card")).toHaveLength(1);
  });

  /** Reopening the conversation later must draw the run the way it settled live. */
  it("draws a two-call run from history as the same folded header", async () => {
    useAgentThemeStore.setState({ transcriptLiveLine: true });
    const el = await draw(<ToolGroup tools={twoCalls} isActivelyStreaming={false} />);

    expect(el.querySelector(".agw-tool-group-head")?.getAttribute("aria-expanded")).toBe("false");
  });

  it("keeps a two-call run as two rows when the live line is off", async () => {
    const el = await draw(<ToolGroup tools={twoCalls} isActivelyStreaming={false} />);

    expect(el.querySelector(".agw-tool-group-head")).toBeNull();
    expect(el.querySelectorAll(".agw-tool-card")).toHaveLength(2);
  });

  it("does not replay the entrance of calls the line already showed, but plays it for new ones", async () => {
    useAgentThemeStore.setState({ transcriptLiveLine: true, transcriptSmoothTools: true });
    const el = await draw(<ToolGroup tools={twoCalls} isActivelyStreaming isLastRow />);

    await act(async () => {
      (el.querySelector(".agw-tool-liveline-count") as HTMLButtonElement).click();
    });
    expect(el.querySelectorAll(".agw-tool-step[data-enter]")).toHaveLength(0);

    const three = [...twoCalls, read("c3", "internal/tunnel/wireguard/splitdevice.go", false)];
    await redraw(<ToolGroup tools={three} isActivelyStreaming isLastRow />);

    const entering = el.querySelectorAll(".agw-tool-step[data-enter]");
    expect(entering).toHaveLength(1);
    expect(entering[0].textContent).toContain("splitdevice.go");
  });

  /** Parallel calls: the newest can finish first. The line is not waiting
   *  while an older call in the run is still running. */
  it("does not shimmer while an older parallel call is still running", async () => {
    useAgentThemeStore.setState({ transcriptLiveLine: true });
    const parallel = [read("p1", "a.go", false), read("p2", "b.go", true)];
    const el = await draw(<ToolGroup tools={parallel} isActivelyStreaming isLastRow />);

    expect(el.querySelector(".agw-tool-liveline")?.hasAttribute("data-waiting")).toBe(false);
  });
});

describe("Transcript → One live line for tool calls", () => {
  it("draws a live run as one line showing only the call running now", async () => {
    useAgentThemeStore.setState({ transcriptLiveLine: true });
    const el = await draw(<ToolGroup tools={run} isActivelyStreaming isLastRow />);

    expect(el.querySelectorAll(".agw-tool-liveline")).toHaveLength(1);
    expect(el.querySelectorAll(".agw-tool-card")).toHaveLength(1);
    expect(el.textContent).toContain("splitdevice.go");
    expect(el.textContent).not.toContain("engine_windows.go");
    // The count opens the whole run; no "N calls · N done" header while live.
    expect(el.querySelector(".agw-tool-liveline-count")?.textContent).toBe("3 calls");
    expect(el.querySelector(".agw-tool-group-head")).toBeNull();
  });

  /**
   * 2026-10-12, DeepSeek V4.1 Flash: the line swapped a finished Read for its
   * own "Thinking" while the model's real reasoning row landed below it — two
   * "Thinking"s, and the call gone from view. Between calls the line keeps the
   * finished call and shimmers; it never writes a label of its own.
   */
  it("keeps the finished call on the line between calls instead of a label of its own", async () => {
    useAgentThemeStore.setState({ transcriptLiveLine: true });
    const finished = run.map((t) => ({ ...t, result: t.result ?? "ok" }));
    const el = await draw(<ToolGroup tools={finished} isActivelyStreaming isLastRow />);
    await act(async () => new Promise((resolve) => setTimeout(resolve, 900)));

    const line = el.querySelector(".agw-tool-liveline");
    expect(line?.hasAttribute("data-waiting")).toBe(true);
    expect(el.textContent).toContain("splitdevice.go");
    expect(el.textContent).not.toContain("Thinking");
  });

  it("opens every call as ordinary rows when the count is clicked", async () => {
    useAgentThemeStore.setState({ transcriptLiveLine: true });
    const el = await draw(<ToolGroup tools={run} isActivelyStreaming isLastRow />);

    await act(async () => {
      (el.querySelector(".agw-tool-liveline-count") as HTMLButtonElement).click();
    });

    expect(el.querySelector(".agw-tool-liveline")).toBeNull();
    expect(el.querySelectorAll(".agw-tool-card")).toHaveLength(3);
  });

  it("draws the run as ordinary rows once the turn has ended", async () => {
    useAgentThemeStore.setState({ transcriptLiveLine: true });
    const finished = run.map((t) => ({ ...t, result: t.result ?? "ok" }));
    const el = await draw(<ToolGroup tools={finished} isActivelyStreaming={false} />);

    expect(el.querySelector(".agw-tool-liveline")).toBeNull();
    expect(el.querySelectorAll(".agw-tool-card")).toHaveLength(3);
  });

  it("leaves a live run as rows when the setting is off", async () => {
    const el = await draw(<ToolGroup tools={run} isActivelyStreaming isLastRow />);

    expect(el.querySelector(".agw-tool-liveline")).toBeNull();
    expect(el.querySelectorAll(".agw-tool-card")).toHaveLength(3);
  });
});
