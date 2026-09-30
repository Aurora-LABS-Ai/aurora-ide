// @vitest-environment jsdom
import { act, useLayoutEffect, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { cancelRefine, runRefine } from "@/apps/agent/adapters/prompt-refine";
import { useAgentRefineStore } from "@/apps/agent/store/composer/useAgentRefineStore";
import { useComposerRefine, type ComposerRefine } from "./useComposerRefine";

vi.mock("@/apps/agent/adapters/prompt-refine", () => ({
  MAX_REFINE_CHARS: 8000,
  runRefine: vi.fn(),
  cancelRefine: vi.fn().mockResolvedValue(true),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

let root: Root;
let container: HTMLDivElement;
let editor: HTMLDivElement;
let controller: ComposerRefine;
let response: ReturnType<typeof deferred<string>>;
let fade: ReturnType<typeof deferred<Animation>>;
let animation: Animation;
const afterChange = vi.fn();

function Composer() {
  const ref = useRef<HTMLDivElement>(null);
  const refine = useComposerRefine(ref, (el) => el.textContent ?? "", afterChange);
  useLayoutEffect(() => { controller = refine; });
  return <div ref={ref} contentEditable suppressContentEditableWarning />;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(runRefine).mockReset();
  vi.mocked(cancelRefine).mockClear();
  afterChange.mockClear();
  response = deferred<string>();
  fade = deferred<Animation>();
  animation = {
    finished: fade.promise,
    cancel: vi.fn(() => fade.reject(new DOMException("Cancelled", "AbortError"))),
  } as unknown as Animation;
  vi.mocked(runRefine).mockReturnValue(response.promise);
  useAgentRefineStore.setState({ enabled: true, llamaDir: "runtime", modelPath: "model.gguf" });
  container = document.createElement("div");
  document.body.append(container);
  act(() => { root = createRoot(container); root.render(<Composer />); });
  editor = container.firstElementChild as HTMLDivElement;
  editor.innerHTML = "<b>Original draft</b>";
  editor.animate = vi.fn(() => animation);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("composer refine reveal", () => {
  it("keeps the draft during the wait and applies the entire result before fading", async () => {
    act(() => controller.run());
    expect(editor.innerHTML).toBe("<b>Original draft</b>");
    expect(controller.phase).toBe("refining");
    await act(async () => response.resolve("A complete, longer refined prompt.\nSecond line."));
    expect(editor.textContent).toBe("A complete, longer refined prompt.\nSecond line.");
    expect(afterChange).toHaveBeenCalledOnce();
    expect(editor.animate).toHaveBeenCalledWith([{ opacity: 0 }, { opacity: 1 }], expect.objectContaining({ duration: 280 }));
    expect(controller.phase).toBe("refining");
    await act(async () => fade.resolve(animation));
    expect(controller.phase).toBe("refined");
    act(() => controller.undo());
    expect(editor.innerHTML).toBe("<b>Original draft</b>");
    expect(controller.phase).toBe("idle");
  });

  it("cancels a pending result without changing the draft", async () => {
    act(() => controller.run());
    act(() => controller.cancel());
    await act(async () => response.resolve("Late result"));
    expect(editor.innerHTML).toBe("<b>Original draft</b>");
    expect(editor.animate).not.toHaveBeenCalled();
    expect(controller.phase).toBe("idle");
  });

  it("restores the original when stopped during the fade", async () => {
    act(() => controller.run());
    await act(async () => response.resolve("Refined prompt"));
    await act(async () => controller.cancel());
    expect(animation.cancel).toHaveBeenCalledOnce();
    expect(editor.innerHTML).toBe("<b>Original draft</b>");
    expect(controller.phase).toBe("idle");
    expect(controller.notice).toBeNull();
  });

  it("does not let an old cancelled request finish a newer request", async () => {
    act(() => controller.run());
    act(() => controller.cancel());
    const next = deferred<string>();
    vi.mocked(runRefine).mockReturnValue(next.promise);
    act(() => controller.run());
    await act(async () => response.resolve("Stale result"));
    expect(editor.textContent).toBe("Original draft");
    expect(controller.phase).toBe("refining");
    await act(async () => next.resolve("Current result"));
    await act(async () => fade.resolve(animation));
    expect(editor.textContent).toBe("Current result");
    expect(controller.phase).toBe("refined");
  });

  it("preserves edits made while the result is pending or fading", async () => {
    act(() => controller.run());
    editor.textContent = "My newer draft";
    act(() => controller.onUserEdit());
    await act(async () => response.resolve("Obsolete rewrite"));
    expect(editor.textContent).toBe("My newer draft");
    response = deferred<string>();
    vi.mocked(runRefine).mockReturnValue(response.promise);
    act(() => controller.run());
    await act(async () => response.resolve("Refined draft"));
    editor.textContent = "My edited rewrite";
    await act(async () => controller.onUserEdit());
    expect(editor.textContent).toBe("My edited rewrite");
    expect(controller.phase).toBe("idle");
  });

  it("keeps the original and stops waiting after an empty result or error", async () => {
    act(() => controller.run());
    await act(async () => response.resolve(" "));
    expect(controller.phase).toBe("idle");
    expect(controller.notice).toBe("The model returned nothing to apply.");
    expect(editor.innerHTML).toBe("<b>Original draft</b>");
    response = deferred<string>();
    vi.mocked(runRefine).mockReturnValue(response.promise);
    act(() => controller.run());
    await act(async () => response.reject(new Error("Model unavailable")));
    expect(controller.phase).toBe("idle");
    expect(controller.notice).toBe("Model unavailable");
    expect(editor.innerHTML).toBe("<b>Original draft</b>");
  });
});
