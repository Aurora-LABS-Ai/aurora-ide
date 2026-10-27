import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { TimelineRow } from "@/apps/agent/components/conversation/timeline";
import { splitTurn, type IndexedRow } from "@/apps/agent/components/conversation/work-log/split-turn";
import { WorkLog } from "@/apps/agent/components/conversation/work-log/WorkLog";
import { GLIDE_MS } from "@/apps/agent/lib/motion/glide";
import { useAgentWorkCardStore } from "@/apps/agent/store/conversation/useAgentWorkCardStore";
import { useAgentThemeStore } from "@/apps/agent/store/ui/useAgentThemeStore";

const tools = (id: string): TimelineRow => ({
  type: "tools",
  id,
  tools: [{ id: `${id}-call`, name: "file_read", arguments: "{}" }],
});

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  useAgentThemeStore.setState({ reduceMotion: true });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  useAgentThemeStore.setState({ reduceMotion: false });
  useAgentWorkCardStore.setState({ openByThread: {}, hydrated: {} });
});

const renderItem = ({ row }: IndexedRow) => (
  <div key={row.id} className="agw-row" data-testid={row.id}>
    {row.id}
  </div>
);

function draw(rows: TimelineRow[], running: boolean, threadId: string | null = null) {
  const split = splitTurn(rows);
  act(() =>
    root.render(
      <WorkLog
        work={split.work}
        tally={split.tally}
        running={running}
        isLast={split.after.length === 0}
        threadId={threadId}
        renderItem={renderItem}
      />,
    ),
  );
}

const head = () => container.querySelector<HTMLButtonElement>(".agw-wc-head")!;
const body = () => container.querySelector<HTMLElement>(".agw-wc-body");
const row = (id: string) => container.querySelector(`[data-testid="${id}"]`);

describe("WorkLog", () => {
  it("shows the newest steps in a window while it runs, and a click on the window opens it", () => {
    draw([tools("a"), tools("b")], true);
    expect(head().textContent).toContain("Working");
    expect(body()?.hasAttribute("data-window")).toBe(true);
    expect(head().getAttribute("aria-expanded")).toBe("false");

    act(() => body()!.click());
    expect(head().getAttribute("aria-expanded")).toBe("true");
    expect(body()?.hasAttribute("data-window")).toBe(false);
  });

  /** Nothing is rebuilt: not by a row arriving, not by opening, not by the turn ending. */
  it("keeps every row's element through new rows, opening and the turn ending", () => {
    draw([tools("a")], true);
    const first = row("a");
    draw([tools("a"), tools("b")], true);
    expect(row("a")).toBe(first);
    act(() => head().click());
    expect(row("a")).toBe(first);
    draw([tools("a"), tools("b")], false);
    expect(row("a")).toBe(first);
    expect(head().textContent).toContain("Worked");
  });

  it("folds to its header when the turn ends, unless the reader opened it", () => {
    draw([tools("a")], true);
    draw([tools("a")], false);
    expect(body()).toBeNull();
    expect(head().getAttribute("aria-expanded")).toBe("false");
  });

  it("opens a finished card on a click and closes it again", () => {
    draw([tools("a")], false);
    expect(body()).toBeNull();
    act(() => head().click());
    expect(row("a")).not.toBeNull();
    act(() => head().click());
    expect(body()).toBeNull();
  });

  /** 2026-10-18 defect 3: a card saved open animated open after the saved state loaded. */
  it("draws a card saved open as open, with no glide", () => {
    useAgentThemeStore.setState({ reduceMotion: false });
    useAgentWorkCardStore.setState({ hydrated: { t: true }, openByThread: { t: { "a-call": true } } });
    draw([tools("a")], false, "t");
    expect(head().getAttribute("aria-expanded")).toBe("true");
    expect(row("a")).not.toBeNull();
    expect(container.querySelector(".agw-wc-anim")?.hasAttribute("data-glide")).toBe(false);
  });

  /** `pin.ts`: one normal scroller that follows the newest row while running,
   *  until the reader clicks a step (it then grows down, nothing pulls). */
  it("follows the newest row while running, and stops once a row is clicked", () => {
    draw([tools("a"), tools("b")], true);
    act(() => head().click());
    expect(body()!.hasAttribute("data-following")).toBe(true);
    act(() => {
      row("a")!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    });
    expect(body()!.hasAttribute("data-following")).toBe(false);
  });

  it("does not follow a finished card, and stops following when the turn ends", () => {
    draw([tools("a")], false);
    act(() => head().click());
    expect(body()!.hasAttribute("data-following")).toBe(false);
    act(() => head().click());

    draw([tools("a")], true);
    act(() => head().click());
    expect(body()!.hasAttribute("data-following")).toBe(true);
    draw([tools("a")], false);
    expect(body()!.hasAttribute("data-following")).toBe(false);
  });

  /** The rows never lose their transform: switching it off and on moved them
   *  off and on their own layer and flipped the text's smoothing (2026-10-27). */
  it("keeps a transform on the rows in every state", () => {
    draw([tools("a")], true);
    const rows = container.querySelector<HTMLElement>(".agw-wc-rows")!;
    expect(rows.style.transform).toBe("translate3d(0, 0px, 0)");
    act(() => head().click());
    act(() => {
      row("a")!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    });
    expect(rows.style.transform).toBe("translate3d(0, 0px, 0)");
    draw([tools("a")], false);
    expect(rows.style.transform).toBe("translate3d(0, 0px, 0)");
  });

  it("glides closed when the turn ends, then removes the body", async () => {
    useAgentThemeStore.setState({ reduceMotion: false });
    draw([tools("a")], true);
    draw([tools("a")], false);
    const anim = container.querySelector(".agw-wc-anim")!;
    expect(anim.hasAttribute("data-glide")).toBe(true);
    expect(anim.hasAttribute("data-expanded")).toBe(false);
    expect(row("a")).not.toBeNull(); // still drawn while it closes
    await act(async () => new Promise((resolve) => setTimeout(resolve, GLIDE_MS + 200)));
    expect(body()).toBeNull();
  });
});
