/**
 * Agent Window — settings search (leaf, non-component).
 *
 * Searching settings answers "where is the switch for X", and the honest answer
 * is the switch itself. The first version filtered the left NAV: typing
 * `chapter` narrowed the sidebar to Preferences and left the reader to open it
 * and hunt the page for a row that was never named. That is a table of contents
 * pretending to be an index.
 *
 * So a query now produces RESULTS IN THE PAGE — the matching rows, rendered
 * live from the same components as their own section, switches and all, so they
 * can be changed on the spot. The sidebar stays complete and untouched while
 * this happens: it is how you navigate, and a nav that rearranges itself as you
 * type takes away the map exactly when you are lost.
 *
 * ── Two levels, and why ───────────────────────────────────────────────────
 * A section is a candidate when its registry entry matches (nav label, title,
 * description, or its `searchTerms` — the controls it is known to contain).
 * Only candidates are MOUNTED, which is what keeps this cheap: settings pages
 * open connections, scan fonts and draw charts on mount, and rendering all of
 * them on every keystroke to ask whether they contain a match would be a real
 * cost for a mostly-empty answer.
 *
 * Within a candidate, `SettingsRow` decides for itself. If the section's own
 * header matched the query, every row shows — the section IS the result. If it
 * did not, only rows whose own label or hint match survive, and a section left
 * with none hides itself.
 */

import { createContext, useContext } from "react";

export interface SettingsSearchEntry {
  id: string;
  navLabel: string;
  title: string;
  description: string;
  searchTerms?: string[];
}

/**
 * Below this the query is treated as absent.
 *
 * One character matches nearly every section, so it would mount the whole
 * settings surface to display a list that is not an answer. Two is where a
 * query starts narrowing anything.
 */
export const MIN_QUERY_LENGTH = 2;

const normalize = (value: string): string => value.trim().toLocaleLowerCase();

/** The comparable form of what the user typed, or `""` when it is not yet a query. */
export function normalizeQuery(raw: string): string {
  const value = normalize(raw);
  return value.length >= MIN_QUERY_LENGTH ? value : "";
}

const WORD_CHAR = /[\p{L}\p{N}]/u;

/**
 * Does this text contain the (already normalized) query, starting at a word?
 *
 * Plain `includes` finds a query inside any word, which reads as a bug the
 * moment it decides an answer: searching `log` matched Skills before it matched
 * Diagnostics, because Skills is indexed under "cata**log**". People search for
 * words, so a match has to begin at one — a prefix of a word still counts
 * ("compact" finds "compaction"), a fragment buried inside one does not.
 */
export function textMatches(text: string, query: string): boolean {
  if (!query) return true;
  const haystack = text.toLocaleLowerCase();
  for (let from = 0; ; from += 1) {
    const at = haystack.indexOf(query, from);
    if (at < 0) return false;
    if (at === 0 || !WORD_CHAR.test(haystack[at - 1])) return true;
    from = at;
  }
}

export function matchesSettingsSearch(entry: SettingsSearchEntry, query: string): boolean {
  const normalizedQuery = normalize(query);
  if (!normalizedQuery) return true;

  return textMatches(
    [entry.navLabel, entry.title, entry.description, ...(entry.searchTerms ?? [])].join(" "),
    normalizedQuery,
  );
}

export function filterSettingsSearch<T extends SettingsSearchEntry>(
  entries: readonly T[],
  query: string,
): T[] {
  return entries.filter((entry) => matchesSettingsSearch(entry, query));
}

/**
 * The indexed control this query hit, if it hit one rather than the section's
 * own name — e.g. `chapter` on Preferences returns `"chapters"`.
 *
 * The command center shows it so a result names the thing you asked for instead
 * of only the page holding it, and uses it as the landing query so opening the
 * result arrives at that control. A section matched by its own name returns
 * `null`: the section IS the answer there, and echoing a stray term would
 * narrow the page for no reason.
 */
export function matchedSearchTerm(
  entry: SettingsSearchEntry,
  query: string,
): string | null {
  // `normalizeQuery`, not `normalize`: a term found from one character would be
  // announced in the result and then handed over as a landing query the
  // settings page ignores, so the page would open unsearched after promising a
  // specific control.
  const normalizedQuery = normalizeQuery(query);
  if (!normalizedQuery) return null;

  const nameMatched = textMatches(
    [entry.navLabel, entry.title].join(" "),
    normalizedQuery,
  );
  if (nameMatched) return null;

  return (entry.searchTerms ?? []).find((term) => textMatches(term, normalizedQuery)) ?? null;
}

// ── Context: the query, and the section subtree it applies to ───────────────

/** The live query, normalized. `""` means "not searching" and everything renders. */
export const SettingsQueryContext = createContext<string>("");

export const useSettingsQuery = (): string => useContext(SettingsQueryContext);

export interface SectionSearchValue {
  /**
   * The section's own header matched, so its whole body is the result and every
   * row inside shows. Without this, searching for a section by NAME would
   * return the section with all its contents hidden.
   */
  sectionMatched: boolean;
  /**
   * A row telling its section whether it matched on its own terms. Reported
   * even by rows that render nothing, because a component returning `null` is
   * still mounted — which is exactly how a section learns it is empty.
   */
  report: (key: string, matched: boolean) => void;
}

export const SectionSearchContext = createContext<SectionSearchValue | null>(null);

export const useSectionSearch = (): SectionSearchValue | null =>
  useContext(SectionSearchContext);

/**
 * Should this row render, and does it count as a match?
 *
 * `matched` is the row's own verdict and is what it reports upward; `visible`
 * additionally honours a section whose header matched. Keeping them separate is
 * what stops a section from claiming a match on the strength of rows that were
 * only shown because the section itself matched.
 */
export function rowSearchState(
  haystack: string,
  query: string,
  sectionMatched: boolean,
): { matched: boolean; visible: boolean } {
  if (!query) return { matched: false, visible: true };
  const matched = textMatches(haystack, query);
  return { matched, visible: matched || sectionMatched };
}
