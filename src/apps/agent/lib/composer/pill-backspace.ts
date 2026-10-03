/**
 * Backspace against an inline composer pill.
 *
 * Pills carry `user-select: none`, which makes Chromium refuse to extend a
 * selection over them, so the native "Backspace removes the whole widget"
 * behavior silently does nothing and the caret parks against the pill forever.
 * Deleting it ourselves restores the contract the pills were designed around.
 */

/** True for the four inline pill kinds: `@` file, `@terminal`, `/` directive, inspector pick. */
export function isPill(node: Node | null): node is HTMLElement {
  if (!node || node.nodeType !== Node.ELEMENT_NODE) return false;
  const el = node as HTMLElement;
  return !!(el.dataset.rel || el.dataset.cmd || el.dataset.sel || el.dataset.term);
}

/** A text node with nothing in it: no character for Backspace to delete. */
const isEmptyText = (node: Node): boolean =>
  node.nodeType === Node.TEXT_NODE && (node.textContent ?? "") === "";

/**
 * The nearest node before `node` that Backspace would actually act on,
 * skipping empty text nodes.
 *
 * Inserting a pill splits the text node it lands in, and deleting the space
 * after a pill can leave that space's node behind empty. Either way an empty
 * text node ends up between the caret and the pill. Looking only at the
 * immediate neighbour found that empty node, decided "not a pill", and left
 * Backspace doing nothing with the caret right after a pill.
 */
function previousMeaningful(node: Node | null): Node | null {
  let current = node;
  while (current && isEmptyText(current)) current = current.previousSibling;
  return current;
}

/**
 * Delete the pill immediately before a collapsed caret inside `root`. Returns
 * whether one was removed, so the caller can decide to preventDefault.
 */
export function deletePillBeforeCaret(root: HTMLElement): boolean {
  const s = window.getSelection();
  if (!s || !s.isCollapsed || s.rangeCount === 0) return false;
  const { startContainer, startOffset } = s.getRangeAt(0);
  if (!root.contains(startContainer)) return false;

  let before: Node | null = null;
  if (startContainer.nodeType === Node.ELEMENT_NODE) {
    // Caret sits between children: the candidate is the child just before it.
    before = startOffset > 0 ? startContainer.childNodes[startOffset - 1] ?? null : null;
  } else if (startContainer.nodeType === Node.TEXT_NODE && startOffset === 0) {
    // Caret at the very start of a text node (typically the emptied space that
    // followed the pill): the candidate is its previous sibling.
    before = startContainer.previousSibling;
  }
  const target = previousMeaningful(before);
  if (!isPill(target)) return false;

  const range = document.createRange();
  range.setStartBefore(target);
  range.collapse(true);
  target.remove();
  s.removeAllRanges();
  s.addRange(range);
  return true;
}
