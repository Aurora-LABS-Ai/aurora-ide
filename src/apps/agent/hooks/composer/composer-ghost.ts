import type { TypingGhost } from "@/apps/agent/adapters/typing-assist";

const RESERVED_HEIGHT = "--agw-ce-ghost-min-h";

/** Prediction state survives removing its DOM span before a native edit. */
export class ComposerGhost {
  private context: string | null = null;
  private candidate: { text: string; ghost: TypingGhost } | null = null;

  /** Keep the opened line while editing this word, including a different prefix. */
  sync(el: HTMLElement, before: string): void {
    const context = before.replace(/[A-Za-z']+$/, "");
    if (!before || context !== this.context) this.clear(el);
    this.context = context;
  }

  remember(before: string, ghost: TypingGhost): void {
    this.candidate = { text: before + ghost.insert, ghost };
  }

  continue(before: string, completion: boolean, nextWord: boolean): TypingGhost | null {
    const candidate = this.candidate;
    if (!candidate || !candidate.text.startsWith(before)) return null;
    const current = before.slice(this.context?.length ?? 0);
    if (current ? !completion || current.length < 2 : !nextWord) return null;
    const insert = candidate.text.slice(before.length);
    if (!insert) return null;
    return { ...candidate.ghost, insert, kind: current ? "completion" : "next_word" };
  }

  /** Called after showing a ghost. CSS still owns the resting height and cap. */
  reserve(el: HTMLElement): void {
    const height = Number.parseFloat(getComputedStyle(el).height);
    if (height > 0) el.style.setProperty(RESERVED_HEIGHT, `${height}px`);
  }

  releaseHeight(el: HTMLElement): void {
    el.style.removeProperty(RESERVED_HEIGHT);
  }

  clear(el: HTMLElement): void {
    this.context = null;
    this.candidate = null;
    this.releaseHeight(el);
  }
}
