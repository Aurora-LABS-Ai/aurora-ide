/**
 * Global suppressor for browser-native `title=""` tooltips.
 *
 * The codebase has ~140 `title="..."` attributes spread across ~70
 * components. Wrapping every one with our themed <Tooltip> would mean
 * touching all of those files. Instead, this module installs a single
 * MutationObserver at startup that strips every `title` attribute the
 * moment it appears in the DOM — so the OS never gets a chance to
 * render its native chrome tooltip on top of our themed UI.
 *
 * Trade-offs:
 *   • Browser tooltips are gone everywhere. Use the <Tooltip /> component
 *     in src/components/ui/Tooltip.tsx for buttons that genuinely need
 *     hover hints (it's already styled to match the IDE chrome).
 *   • `title` is also a (weak) accessibility hint — screen readers prefer
 *     `aria-label` anyway, so this isn't a regression for AT users. If a
 *     specific element needs a screen-reader name, set `aria-label="..."`
 *     instead of `title="..."`.
 *
 * Implementation notes:
 *   • We strip attributes via `removeAttribute('title')`, which itself
 *     fires another mutation event. The observer's loop simply finds no
 *     `title` to remove on the second pass, so there's no infinite loop.
 *   • The observer watches `subtree: true` from <body> so newly-mounted
 *     React nodes are caught the same tick they're added.
 *   • Initial sweep handles anything rendered before the observer
 *     attached (e.g. server-rendered or main.tsx-bootstrapped chrome).
 */

let installed = false;
let observer: MutationObserver | null = null;

/**
 * Walk an element + its descendants and remove every `title` attribute.
 * Cheap: querySelectorAll with the `[title]` selector skips elements
 * that don't have it. */
function stripTitlesIn(root: Element | Document): void {
  // The root itself if it's an Element with a title.
  if (root instanceof Element && root.hasAttribute("title")) {
    root.removeAttribute("title");
  }

  // querySelectorAll('[title]') is a single tree walk in native code —
  // faster than recursing in JS for any non-trivial tree.
  const matches = root.querySelectorAll("[title]");
  for (let i = 0; i < matches.length; i++) {
    matches[i].removeAttribute("title");
  }
}

/**
 * Install the global tooltip suppressor. Idempotent — safe to call
 * multiple times (subsequent calls are no-ops).
 *
 * Returns a cleanup function that disconnects the observer. In
 * practice you never want to call it (the suppressor lives for the
 * full app lifetime), but the test suite uses it to reset state
 * between cases.
 */
export function disableNativeTooltips(): () => void {
  if (installed) return () => undefined;
  installed = true;

  // 1. Initial sweep — catches anything in the DOM at install time.
  stripTitlesIn(document);

  // 2. Live observer — strips titles on any future mutation. We watch
  //    *both* attribute changes (a component setting title="..." on an
  //    existing element) and node additions (a new component mounting
  //    with title baked into its outerHTML).
  observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.type === "attributes" && m.attributeName === "title") {
        const target = m.target as Element;
        if (target.hasAttribute("title")) {
          target.removeAttribute("title");
        }
      } else if (m.type === "childList") {
        m.addedNodes.forEach((node) => {
          if (node.nodeType === Node.ELEMENT_NODE) {
            stripTitlesIn(node as Element);
          }
        });
      }
    }
  });

  observer.observe(document.body, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["title"],
  });

  return () => {
    observer?.disconnect();
    observer = null;
    installed = false;
  };
}
