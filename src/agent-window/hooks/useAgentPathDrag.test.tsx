import React, { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import { useAgentPathDrag } from "./useAgentPathDrag";
import { useAgentPathDrop } from "./useAgentPathDrop";
import { useAgentDragStore } from "../store/useAgentDragStore";

const PATH = "C:/proj/src/app.ts";

/** Coordinator + one drop zone, wired exactly as the window wires them. */
const Harness: React.FC<{ onPaths: (paths: string[]) => void }> = ({ onPaths }) => {
  useAgentPathDrag();
  const ref = useRef<HTMLDivElement>(null);
  const isOver = useAgentPathDrop(ref, onPaths);
  return <div ref={ref} data-testid="zone" data-over={isOver || undefined} />;
};

describe("dragging a path onto a drop zone", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  let zone: HTMLElement;
  let onPaths: Mock<(paths: string[]) => void>;
  /** jsdom models no layout, so the hit test is stubbed: coordinates left of
   *  this line are "over the zone". The real hit test is the browser's. */
  const OVER_X = 40;

  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;

    useAgentDragStore.setState({
      pendingPath: null,
      pendingName: null,
      startX: 0,
      startY: 0,
      path: null,
      name: null,
      isDragging: false,
      x: 0,
      y: 0,
      endedAt: 0,
    });

    container = document.createElement("div");
    document.body.appendChild(container);
    onPaths = vi.fn();

    act(() => {
      root = createRoot(container);
      root.render(<Harness onPaths={onPaths} />);
    });
    zone = container.querySelector<HTMLElement>("[data-testid='zone']")!;

    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      writable: true,
      value: (x: number) => (x <= OVER_X ? zone : document.body),
    });
  });

  afterEach(() => {
    act(() => root?.unmount());
    container.remove();
    delete (document as { elementFromPoint?: unknown }).elementFromPoint;
  });

  const press = (x: number, y: number, isDir = false) =>
    act(() => {
      useAgentDragStore.getState().prepare(PATH, "app.ts", x, y, isDir);
    });

  const move = (x: number, y: number) =>
    act(() => {
      document.dispatchEvent(new MouseEvent("mousemove", { clientX: x, clientY: y }));
    });

  const release = () =>
    act(() => {
      document.dispatchEvent(new MouseEvent("mouseup"));
    });

  it("marks the zone as the drop target and hands it the path", () => {
    press(200, 200);
    move(20, 210); // past the threshold, over the zone

    expect(zone.dataset.over).toBe("true");

    release();

    expect(onPaths).toHaveBeenCalledWith([PATH], { isDir: false });
    expect(zone.dataset.over).toBeUndefined();
    expect(useAgentDragStore.getState().isDragging).toBe(false);
  });

  /** A folder must arrive MARKED as one: the composer tells the model to look
   *  inside a directory rather than try to read it. */
  it("carries the folder flag through to the drop", () => {
    press(200, 200, true);
    move(20, 210);
    release();

    expect(onPaths).toHaveBeenCalledWith([PATH], { isDir: true });
  });

  it("releases outside the zone without dropping", () => {
    press(200, 200);
    move(20, 210);
    move(900, 210); // dragged back out
    expect(zone.dataset.over).toBeUndefined();

    release();

    expect(onPaths).not.toHaveBeenCalled();
  });

  /** A press that never travels is a click on the row, not a drag — the zone
   *  must never light up and nothing may be delivered. */
  it("ignores a press that never becomes a drag", () => {
    press(20, 20);
    move(22, 21);
    expect(zone.dataset.over).toBeUndefined();

    release();

    expect(onPaths).not.toHaveBeenCalled();
  });

  it("cancels the drag on Escape", () => {
    press(200, 200);
    move(20, 210);

    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });

    expect(zone.dataset.over).toBeUndefined();
    expect(useAgentDragStore.getState().isDragging).toBe(false);

    release();
    expect(onPaths).not.toHaveBeenCalled();
  });
});
