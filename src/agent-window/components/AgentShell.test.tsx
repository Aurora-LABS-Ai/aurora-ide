import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useAgentThemeStore } from "../store/useAgentThemeStore";
import { useAgentWorkspaceStore } from "../store/useAgentWorkspaceStore";
import { AgentShell } from "./AgentShell";

vi.mock("../hooks/useAgentFsWatch", () => ({ useAgentFsWatch: vi.fn() }));
vi.mock("../hooks/useAgentBrowserOpen", () => ({ useAgentBrowserOpen: vi.fn() }));
vi.mock("./LeftRail", () => ({ LeftRail: () => <div>Rail</div> }));
vi.mock("./ConversationPane", () => ({ ConversationPane: () => <div>Conversation</div> }));
vi.mock("./RightDock", () => ({ RightDock: () => <div>Dock</div> }));

class ResizeObserverStub implements ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

describe("AgentShell divider drag", () => {
  let container: HTMLDivElement;
  let root: Root | null;
  let capturedPointer: number | null;

  beforeEach(async () => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    globalThis.ResizeObserver = ResizeObserverStub;
    capturedPointer = null;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      right: 1000,
      bottom: 700,
      left: 0,
      width: 1000,
      height: 700,
      toJSON: () => ({}),
    });
    Object.defineProperties(HTMLElement.prototype, {
      setPointerCapture: {
        configurable: true,
        value: (pointerId: number) => {
          capturedPointer = pointerId;
        },
      },
      hasPointerCapture: {
        configurable: true,
        value: (pointerId: number) => capturedPointer === pointerId,
      },
      releasePointerCapture: {
        configurable: true,
        value: (pointerId: number) => {
          if (capturedPointer === pointerId) capturedPointer = null;
        },
      },
    });
    useAgentThemeStore.setState({ railGlide: false });
    useAgentWorkspaceStore.setState({
      railOpen: false,
      railWidth: 18,
      dockOpen: true,
      dockWidth: 36,
      expanded: false,
      tabs: [{ id: "canvas", kind: "canvas", title: "Canvas" }],
      activeTabId: "canvas",
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root?.render(<AgentShell />));
  });

  afterEach(async () => {
    await act(async () => root?.unmount());
    container?.remove();
    Reflect.deleteProperty(HTMLElement.prototype, "setPointerCapture");
    Reflect.deleteProperty(HTMLElement.prototype, "hasPointerCapture");
    Reflect.deleteProperty(HTMLElement.prototype, "releasePointerCapture");
    vi.restoreAllMocks();
  });

  it("captures the pointer and stops resizing as soon as the primary button is released", () => {
    const handle = container.querySelector<HTMLDivElement>(
      '[aria-label="Resize conversation and right panel"]',
    );
    expect(handle).not.toBeNull();

    act(() => {
      handle!.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          button: 0,
          buttons: 1,
          clientX: 700,
          pointerId: 9,
        }),
      );
      handle!.dispatchEvent(
        new PointerEvent("pointermove", {
          bubbles: true,
          buttons: 1,
          clientX: 300,
          pointerId: 9,
        }),
      );
    });
    expect(capturedPointer).toBe(9);
    expect(useAgentWorkspaceStore.getState().dockWidth).toBe(52);

    act(() => {
      handle!.dispatchEvent(
        new PointerEvent("pointermove", {
          bubbles: true,
          buttons: 0,
          clientX: 500,
          pointerId: 9,
        }),
      );
      handle!.dispatchEvent(
        new PointerEvent("pointermove", {
          bubbles: true,
          buttons: 1,
          clientX: 650,
          pointerId: 9,
        }),
      );
    });

    expect(capturedPointer).toBeNull();
    expect(useAgentWorkspaceStore.getState().dockWidth).toBe(52);
    expect(container.querySelector(".agw-shell-flex")?.hasAttribute("data-agw-dragging")).toBe(
      false,
    );
  });
});
