/**
 * Agent Window — get a tool card's body ready before it opens [service].
 *
 * Opening a file read or a file edit used to do its two heavy jobs at the
 * moment of the click, under the opening motion: work out the diff, and
 * colour every line. Both now cache (`computeDiffCached`, `useShikiTokens`);
 * this starts them when the pointer reaches the card's row, in idle time, so
 * the click finds them done.
 */

import { computeDiffCached } from "@/apps/agent/components/tool-views/diff";
import type { ParsedToolResult } from "@/apps/agent/components/tool-views/tool-result";
import { extToShikiLang, warmShikiTokens, type ShikiThemeVariant } from "@/kernel/ui/useShikiTokens";

/** Same ceiling the views use: past it they render plain text. */
const HIGHLIGHT_MAX_CHARS = 50_000;

function languageOf(path: string | null | undefined): string | null {
  if (!path) return null;
  const base = path.split(/[/\\]/).pop() ?? path;
  const dot = base.lastIndexOf(".");
  return dot >= 0 ? extToShikiLang(base.slice(dot + 1).toLowerCase()) : null;
}

const idle = (work: () => void): void => {
  const ric = (globalThis as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number })
    .requestIdleCallback;
  if (ric) ric(work, { timeout: 400 });
  else setTimeout(work, 30);
};

export function warmToolResult(
  parsed: ParsedToolResult,
  variant: ShikiThemeVariant,
  syntaxOn: boolean,
): void {
  const diffs = parsed.diffs?.length ? [parsed.diffs[0]] : parsed.diff ? [parsed.diff] : [];
  for (const diff of diffs) {
    idle(() => {
      computeDiffCached(diff.oldText, diff.newText);
    });
    const lang = syntaxOn ? languageOf(diff.fullPath ?? diff.path) : null;
    if (lang && diff.oldText.length <= HIGHLIGHT_MAX_CHARS && diff.newText.length <= HIGHLIGHT_MAX_CHARS) {
      warmShikiTokens(diff.oldText, lang, variant);
      warmShikiTokens(diff.newText, lang, variant);
    }
  }
  if (parsed.code && syntaxOn && parsed.code.length <= HIGHLIGHT_MAX_CHARS) {
    warmShikiTokens(parsed.code, languageOf(parsed.codePath), variant);
  }
}
