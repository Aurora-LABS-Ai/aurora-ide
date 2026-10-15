import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const commands = vi.hoisted(() => ({
  getAnswerBoxes: vi.fn(),
  setAnswerBox: vi.fn(),
}));
vi.mock("@/apps/agent/services/answer-box/commands", () => commands);

import { AnswerBox } from "./AnswerBox";
import { ANSWER_BOX_EXAMPLES } from "@/apps/agent/lib/answer-box/instructions";
import { boxKey } from "@/apps/agent/lib/answer-box/split";
import { ConversationScopeContext } from "@/apps/agent/lib/thread/conversation-scope";
import { useAnswerBoxStore } from "@/apps/agent/store/answer-box/useAnswerBoxStore";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement | null = null;
let root: Root | null = null;

const scope = { threadId: "t1", projectRoot: null };

const render = async (node: React.ReactNode): Promise<HTMLDivElement> => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(<ConversationScopeContext.Provider value={scope}>{node}</ConversationScopeContext.Provider>);
  });
  return host;
};

const rows = (output: HTMLElement) =>
  [...output.querySelectorAll(".ac-row")].map(
    (row) => `${row.querySelector(".ac-row-title")?.textContent}=${row.querySelector(".ac-row-value")?.textContent}`,
  );

/** Let the store's queued save run. */
const flush = () => act(async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
});

beforeEach(() => {
  commands.getAnswerBoxes.mockResolvedValue({ boxes: {} });
  commands.setAnswerBox.mockResolvedValue({ boxes: {} });
  useAnswerBoxStore.setState({ byThread: {}, hydrated: {} });
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.clearAllMocks();
});

describe("AnswerBox", () => {
  it("draws the roast box with the SDK's parts and recomputes as the stepper moves", async () => {
    const output = await render(<AnswerBox source={ANSWER_BOX_EXAMPLES.roast} closed fallback={null} />);
    expect(output.querySelector(".ac-stepper-large")).not.toBeNull();
    expect(output.querySelector('[role="spinbutton"]')?.textContent).toBe("6");
    expect(rows(output)).toContain("Bone-in leg of lamb=2.4 kg");

    await act(async () => output.querySelector<HTMLButtonElement>('[aria-label="Increase Number of people"]')!.click());
    expect(rows(output)).toContain("Bone-in leg of lamb=2.8 kg");
    expect(output.querySelector(".agw-abox-reset")?.textContent).toBe("Back to 6");
  });

  it("saves only what changed, keyed by the box's text, and forgets it on reset", async () => {
    const output = await render(<AnswerBox source={ANSWER_BOX_EXAMPLES.roast} closed fallback={null} />);
    const key = boxKey(ANSWER_BOX_EXAMPLES.roast);
    await act(async () => output.querySelector<HTMLButtonElement>('[aria-label="Increase Number of people"]')!.click());
    await flush();
    expect(commands.setAnswerBox).toHaveBeenLastCalledWith("t1", key, { people: 7 });

    await act(async () => output.querySelector<HTMLButtonElement>(".agw-abox-reset")!.click());
    await flush();
    expect(commands.setAnswerBox).toHaveBeenLastCalledWith("t1", key, {});
    expect(output.querySelector(".agw-abox-reset")).toBeNull();
    expect(rows(output)).toContain("Bone-in leg of lamb=2.4 kg");
  });

  it("opens at the value the reader left it at", async () => {
    commands.getAnswerBoxes.mockResolvedValue({
      boxes: { [boxKey(ANSWER_BOX_EXAMPLES.roast)]: { people: 9 } },
    });
    const output = await render(<AnswerBox source={ANSWER_BOX_EXAMPLES.roast} closed fallback={null} />);
    await flush();
    expect(output.querySelector('[role="spinbutton"]')?.textContent).toBe("9");
    expect(rows(output)).toContain("Bone-in leg of lamb=3.6 kg");
  });

  it("does not read or save while the model is still writing the box", async () => {
    const half = ANSWER_BOX_EXAMPLES.roast.split("\n").slice(0, 3).join("\n");
    const output = await render(<AnswerBox source={half} closed={false} fallback={null} />);
    expect(commands.getAnswerBoxes).not.toHaveBeenCalled();
    expect(output.querySelector(".agw-abox")?.getAttribute("aria-busy")).toBe("true");
    // The third line has no newline after it yet, so it is held back.
    expect(rows(output)).toEqual([]);
    expect(output.querySelector(".agw-abox-problems")).toBeNull();
  });

  it("names the lines it skipped, and falls back to the source when nothing can be drawn", async () => {
    const partly = await render(
      <AnswerBox source={`stepper n "N" 2 min=1 max=9\nslider x "X" 1\nrow "Twice" = n * 2`} closed fallback={null} />,
    );
    expect(rows(partly)).toEqual(["Twice=4"]);
    expect(partly.querySelector(".agw-abox-problems")?.textContent).toContain("Line 2:");
    act(() => root?.unmount());

    const broken = await render(
      <AnswerBox source={`slider x "X" 1`} closed fallback={<pre className="fallback">source</pre>} />,
    );
    expect(broken.querySelector(".agw-abox")).toBeNull();
    expect(broken.querySelector(".agw-abox-failed-note")?.textContent).toContain("line 1");
    expect(broken.querySelector(".fallback")).not.toBeNull();
  });

  it("re-ranks a comparison when the measure changes", async () => {
    const output = await render(<AnswerBox source={ANSWER_BOX_EXAMPLES.compare} closed fallback={null} />);
    const labels = () => [...output.querySelectorAll(".ac-chart-label")].map((l) => l.textContent);
    expect(labels()).toEqual(["Mendocino", "Monterey", "Lake Tahoe"]);
    const things = [...output.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find(
      (b) => b.textContent === "Things to do",
    )!;
    await act(async () => things.click());
    expect(labels()).toEqual(["Monterey", "Lake Tahoe", "Mendocino"]);
  });
});
