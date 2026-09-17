// @vitest-environment jsdom
import { act, useLayoutEffect, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { correctWord, queryTyping, type TypingGhost } from "@/apps/agent/adapters/typing-assist";
import { useAgentTypingStore } from "@/apps/agent/store/composer/useAgentTypingStore";
import { serializeFragment, useComposerTyping, type ComposerTyping } from "./useComposerTyping";

vi.mock("@/apps/agent/adapters/typing-assist", () => ({
  ensureTypingReady: vi.fn().mockResolvedValue(true),
  queryTyping: vi.fn(),
  correctWord: vi.fn().mockResolvedValue(null),
  learnWord: vi.fn(),
  undoCorrect: vi.fn(),
  flushTyping: vi.fn(),
}));

let root: Root;
let container: HTMLDivElement;
let editor: HTMLDivElement;
let typing: ComposerTyping;

function Composer() {
  const ref = useRef<HTMLDivElement>(null);
  const controller = useComposerTyping(ref);
  useLayoutEffect(() => { typing = controller; });
  return <div ref={ref} contentEditable role="textbox" style={{ height: 44 }}
    onInput={controller.onInput} onKeyDown={controller.onKeyDown} onBlur={controller.clearGhost} />;
}

function caret(node: Node, offset: number) {
  window.getSelection()!.collapse(node, offset);
}

function input(text: string) {
  editor.textContent = text;
  if (editor.firstChild) caret(editor.firstChild, text.length);
  else caret(editor, 0);
  act(() => typing.onInput());
}

function key(key: string, options: KeyboardEventInit = {}) {
  act(() => editor.dispatchEvent(new KeyboardEvent("keydown", {
    key, bubbles: true, cancelable: true, ...options,
  })));
}

async function settle() {
  await act(async () => { await vi.advanceTimersByTimeAsync(120); });
}

const ghost = () => editor.querySelector<HTMLElement>("[data-ghost]");
const reserved = () => editor.style.getPropertyValue("--agw-ce-ghost-min-h");

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    disconnect() {}
  });
  vi.mocked(queryTyping).mockReset();
  vi.mocked(correctWord).mockClear();
  useAgentTypingStore.setState({ completion: true, nextWord: true, autocorrect: false, learn: false });
  container = document.createElement("div");
  document.body.append(container);
  act(() => {
    root = createRoot(container);
    root.render(<Composer />);
  });
  editor = container.querySelector("[role=textbox]")!;
  editor.focus();
  vi.mocked(queryTyping).mockImplementation(async (before, completion, nextWord) => {
    const current = before.match(/[a-z']*$/i)![0];
    if (completion && current.length >= 2 && "about".startsWith(current) && current !== "about") {
      return { insert: "about".slice(current.length), word: "about", kind: "completion" };
    }
    if (nextWord && !current && before.trim()) {
      return { insert: "about", word: "about", kind: "next_word" };
    }
    return null;
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("composer prediction lifecycle", () => {
  it("continues a matching word and its Backspace immediately without another lookup", async () => {
    input("Please tell me ab");
    await settle();
    expect(ghost()?.textContent).toBe("out→");
    expect(serializeFragment(editor)).toBe("Please tell me ab");

    key("o");
    expect(ghost()).toBeNull(); // Native editing must still see only the user's text.
    input("Please tell me abo");
    expect(ghost()?.textContent).toBe("ut→");
    key("Backspace");
    input("Please tell me ab");
    expect(ghost()?.textContent).toBe("out→");
    await settle();
    expect(queryTyping).toHaveBeenCalledTimes(1);
  });

  it("keeps reserved space through a changed prefix and an empty lookup, then releases it on clear", async () => {
    input("Please tell me ab");
    await settle();
    const height = reserved();
    expect(height).not.toBe("");
    key("x");
    input("Please tell me abx");
    expect(ghost()).toBeNull();
    expect(reserved()).toBe(height);
    await settle();
    expect(ghost()).toBeNull();
    expect(reserved()).toBe(height);
    act(() => typing.clearGhost());
    expect(reserved()).toBe("");
    input("");
    await settle();
    expect(ghost()).toBeNull();
  });

  it("ends the reservation when the user finishes the word", async () => {
    input("Please tell me ab");
    await settle();
    key(" ");
    input("Please tell me about ");
    expect(reserved()).toBe("");
    expect(ghost()).toBeNull();
    await settle();
    expect(ghost()?.textContent).toBe("about→");
  });

  it("cancels an in-flight prediction on Escape even before any ghost has appeared", async () => {
    let resolve!: (value: TypingGhost) => void;
    vi.mocked(queryTyping).mockReturnValueOnce(new Promise(r => { resolve = r; }));
    input("Please tell me ab");
    await settle();
    key("Escape");
    await act(async () => resolve({ insert: "out", word: "about", kind: "completion" }));
    expect(ghost()).toBeNull();
    expect(reserved()).toBe("");
  });

  it("rejects a stale lookup after the typed prefix changes", async () => {
    let resolve!: (value: TypingGhost) => void;
    vi.mocked(queryTyping).mockReturnValueOnce(new Promise(r => { resolve = r; }));
    input("Please tell me ab");
    await settle();
    key("x");
    input("Please tell me abx");
    await act(async () => resolve({ insert: "out", word: "about", kind: "completion" }));
    expect(ghost()).toBeNull();
  });

  it("clears the prediction and reservation on a settings change", async () => {
    input("Please tell me ab");
    await settle();
    act(() => useAgentTypingStore.setState({ completion: false, nextWord: false }));
    expect(ghost()).toBeNull();
    expect(reserved()).toBe("");
    input("Please tell me abo");
    await settle();
    expect(ghost()).toBeNull();
  });

  it("clears on caret movement, blur and composition, and never predicts mid-composition", async () => {
    for (const gesture of ["selectionchange", "blur", "compositionstart"]) {
      editor.focus();
      input("Please tell me ab");
      await settle();
      expect(ghost()).not.toBeNull();
      act(() => {
        if (gesture === "selectionchange") {
          caret(editor.firstChild!, 2);
          document.dispatchEvent(new Event(gesture));
        } else if (gesture === "blur") editor.blur();
        else editor.dispatchEvent(new CompositionEvent(gesture));
      });
      expect(ghost()).toBeNull();
      expect(reserved()).toBe("");
    }
    input("Please tell me abo");
    await settle();
    expect(ghost()).toBeNull();
  });

  it("removes the span before edits without a keydown, and preserves the reservation", async () => {
    input("Please tell me ab");
    await settle();
    const height = reserved();
    editor.dispatchEvent(new InputEvent("beforeinput", { inputType: "insertFromPaste" }));
    expect(ghost()).toBeNull();
    expect(reserved()).toBe(height);
  });

  it("keeps autocorrect available when editing an earlier word", async () => {
    act(() => useAgentTypingStore.setState({ autocorrect: true }));
    editor.textContent = "teh rest of the sentence";
    caret(editor.firstChild!, 4);
    act(() => typing.onInput());
    await settle();
    expect(correctWord).toHaveBeenCalledWith("teh", "");
    expect(ghost()).toBeNull();
  });

  it("accepts only the remaining prediction and keeps the arrow out of the draft", async () => {
    const insert = vi.fn((_command: string, _ui: boolean, text: string) => {
      expect(ghost()).toBeNull();
      input(serializeFragment(editor) + text);
      return true;
    });
    Object.defineProperty(document, "execCommand", { configurable: true, value: insert });
    input("Please tell me ab");
    await settle();
    key("o");
    input("Please tell me abo");
    key("ArrowRight");
    expect(insert).toHaveBeenCalledWith("insertText", false, "ut");
    expect(serializeFragment(editor)).toBe("Please tell me about");
    expect(ghost()).toBeNull();
  });
});
