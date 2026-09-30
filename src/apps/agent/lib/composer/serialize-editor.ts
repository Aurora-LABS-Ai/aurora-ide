import { useAgentSelectionStore } from "@/apps/agent/store/composer/useAgentSelectionStore";

/** Serialize contenteditable text and pills for a draft or outgoing message. */
export function serializeEditor(
  root: HTMLElement,
  forSend = false,
  allowWorkspaceRefs = true,
  allowedCommandKeys?: ReadonlySet<string>,
): string {
  let out = "";
  const walk = (node: ChildNode) => {
    if (node.nodeType === Node.TEXT_NODE) {
      out += node.textContent ?? "";
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as HTMLElement;
    if (el.dataset.ghost) return;
    if (el.dataset.cmd) {
      if (allowedCommandKeys && !allowedCommandKeys.has(el.dataset.cmd)) return;
      // The command has an effect in the staging store. Keep its place in the
      // outgoing sentence, while a command-only draft stays unsendable.
      if (forSend && el.dataset.cmdTitle) out += `/${el.dataset.cmdTitle}`;
      return;
    }
    if (el.dataset.term) {
      if (!allowWorkspaceRefs) return;
      if (forSend) out += `@terminal:${el.dataset.term}`;
      return;
    }
    if (el.dataset.sel) {
      if (!allowWorkspaceRefs) return;
      if (forSend) {
        const entry = useAgentSelectionStore
          .getState()
          .selected.find((selected) => selected.id === el.dataset.sel);
        if (entry) out += `@element:${entry.index}`;
      }
      return;
    }
    if (el.dataset.rel) {
      if (allowWorkspaceRefs) out += `@${el.dataset.rel}`;
      return;
    }
    if (el.tagName === "BR") {
      out += "\n";
      return;
    }
    const isBlock = el.tagName === "DIV" || el.tagName === "P";
    if (isBlock && out.length > 0 && !out.endsWith("\n")) out += "\n";
    el.childNodes.forEach(walk);
  };
  root.childNodes.forEach(walk);
  return out;
}
