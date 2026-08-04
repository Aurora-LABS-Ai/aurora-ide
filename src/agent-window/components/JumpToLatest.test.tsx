import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { JumpToLatest } from "./JumpToLatest";

describe("JumpToLatest", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  const render = (node: React.ReactElement) => {
    act(() => {
      root ??= createRoot(container);
      root.render(node);
    });
  };

  const button = () => container.querySelector("button.agw-jumplatest");

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container.remove();
  });

  it("renders nothing while the reader is at the bottom", () => {
    render(<JumpToLatest show={false} onJump={() => {}} />);
    expect(container.innerHTML).toBe("");
  });

  it("returns the reader to the newest content when pressed", () => {
    const onJump = vi.fn();
    render(<JumpToLatest show onJump={onJump} />);

    act(() => {
      button()?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onJump).toHaveBeenCalledTimes(1);
  });

  /**
   * The live dot is the visual cue that content is arriving below the fold. It
   * must never be the ONLY carrier of that state, so the accessible name has to
   * change with it.
   */
  it("names the streaming state in the accessible label, not only the dot", () => {
    render(<JumpToLatest show onJump={() => {}} />);
    expect(button()?.getAttribute("aria-label")).toBe("Jump to latest");
    expect(container.querySelector(".agw-jumplatest-live")).toBeNull();

    render(<JumpToLatest show streaming onJump={() => {}} />);
    expect(button()?.getAttribute("aria-label")).toBe(
      "Jump to latest — the agent is still writing",
    );
    expect(container.querySelector(".agw-jumplatest-live")).not.toBeNull();
  });

  /**
   * Shown whenever the reader is away from the bottom — being lost in a
   * FINISHED conversation is the common case, and gating on streaming would
   * make the control vanish under the cursor the moment a turn ended.
   */
  it("stays available when no turn is streaming", () => {
    render(<JumpToLatest show streaming={false} onJump={() => {}} />);
    expect(button()).not.toBeNull();
  });
});
