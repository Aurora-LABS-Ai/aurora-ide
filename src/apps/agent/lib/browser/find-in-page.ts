/**
 * Find in page, run inside the page.
 *
 * WebView2's own find bar is not exposed by Tauri, so the panel searches the
 * page itself: every visible text node is scanned for the query (case
 * insensitive), and the matches are painted with the CSS Custom Highlight API.
 * Nothing in the page's DOM is wrapped or rewritten, so a page's own scripts
 * and styles see exactly what they saw before — the highlight is a paint-only
 * layer, and clearing it leaves no trace.
 *
 * Kept as plain JavaScript source rather than a serialized TS function: the
 * bundler is free to rename or wrap a function, and this text has to run
 * as-is in someone else's page.
 *
 * Known limit: a match split across two elements (`<b>web</b>hook`) is not
 * found. Real browsers stitch text runs together; this does not.
 */

const FIND_FN = String.raw`(function (query, want) {
  var H = "aurora-find", C = "aurora-find-current";
  var reg = (typeof CSS !== "undefined" && CSS.highlights) ? CSS.highlights : null;
  if (reg) { reg.delete(H); reg.delete(C); }
  if (!document.getElementById("__aurora_find_style")) {
    var st = document.createElement("style");
    st.id = "__aurora_find_style";
    st.textContent = "::highlight(aurora-find){background-color:#ffd84d;color:#111}" +
      "::highlight(aurora-find-current){background-color:#ff9f43;color:#111}";
    (document.head || document.documentElement).appendChild(st);
  }
  var q = String(query || "");
  if (!q) return { count: 0, index: -1, capped: false, supported: !!reg };
  var needle = q.toLowerCase();
  var MAX = 1000;
  var ranges = [];
  var root = document.body || document.documentElement;
  var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: function (n) {
      var p = n.parentElement;
      if (!p) return NodeFilter.FILTER_REJECT;
      var tag = p.tagName;
      if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT" || tag === "TEMPLATE") {
        return NodeFilter.FILTER_REJECT;
      }
      if (!n.nodeValue || !n.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
      // Not rendered (display:none, detached): nothing to show, so no match.
      if (p.getClientRects().length === 0) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });
  var node;
  outer: while ((node = walker.nextNode())) {
    var text = node.nodeValue.toLowerCase();
    var i = text.indexOf(needle);
    while (i !== -1) {
      var r = document.createRange();
      r.setStart(node, i);
      r.setEnd(node, i + needle.length);
      ranges.push(r);
      if (ranges.length >= MAX) break outer;
      i = text.indexOf(needle, i + needle.length);
    }
  }
  if (!ranges.length) return { count: 0, index: -1, capped: false, supported: !!reg };
  var index = ((want % ranges.length) + ranges.length) % ranges.length;
  if (reg && typeof Highlight !== "undefined") {
    reg.set(H, new Highlight(...ranges));
    reg.set(C, new Highlight(ranges[index]));
  }
  var el = ranges[index].startContainer.parentElement;
  if (el && el.scrollIntoView) el.scrollIntoView({ block: "center", inline: "nearest" });
  return { count: ranges.length, index: index, capped: ranges.length >= MAX, supported: !!reg };
})`;

const CLEAR_FN = String.raw`(function () {
  if (typeof CSS !== "undefined" && CSS.highlights) {
    CSS.highlights.delete("aurora-find");
    CSS.highlights.delete("aurora-find-current");
  }
  return true;
})`;

export interface FindResult {
  /** Matches found (capped at 1000). */
  count: number;
  /** The current match, 0-based; -1 when there is none. */
  index: number;
  /** More than 1000 matches: `count` is a floor. */
  capped: boolean;
  /** The page can paint highlights. False = matches are found and scrolled to, not painted. */
  supported: boolean;
}

/** Script that finds `query` and makes match `index` (wrapping) current. */
export function findScript(query: string, index: number): string {
  return `${FIND_FN}(${JSON.stringify(query)}, ${Math.trunc(index) || 0})`;
}

/** Script that removes every find highlight from the page. */
export function clearFindScript(): string {
  return `${CLEAR_FN}()`;
}
