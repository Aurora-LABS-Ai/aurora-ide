/**
 * What the Canvas reads out of a `report` artifact.
 *
 * A report is Markdown — the same source the model already writes well, the
 * same thing that exports as Markdown with no conversion — plus three
 * conventions a long research document needs and ordinary prose does not:
 *
 * - `##` and `###` headings become the contents strip, so a document you scroll
 *   for two minutes tells you where you are in it.
 * - `[^1]` markers and their `[^1]: …` definitions become NUMBERED SOURCES you
 *   can open. Markdown's own footnotes would render a link to the bottom of the
 *   page; a research citation has to reach the thing it cites.
 * - A block quotation whose last line opens with an em dash is an attributed
 *   passage. Nothing here parses that — it is a styling convention the renderer
 *   honours — but it is documented with the other two because the three are one
 *   contract the tool description teaches.
 *
 * Everything is derived from the source on read. Nothing is stored beside it,
 * so a report edited by a patch cannot fall out of step with its own contents.
 */

/** One entry in the contents strip. */
export interface ReportHeading {
  /**
   * Position among the document's rendered `h2`/`h3` elements, in order.
   *
   * The renderer scrolls by INDEX rather than by id: the body goes through the
   * shared Markdown component, which does not put ids on headings, and the
   * alternative — slugging the text and hoping the renderer slugs it the same
   * way — breaks silently the first time two sections share a name.
   */
  index: number;
  level: 2 | 3;
  text: string;
}

/** One numbered source, from a `[^key]: …` definition. */
export interface ReportSource {
  /** Display number, assigned in the order the definitions appear. */
  n: number;
  /** The key as written — `1`, `brooks`, `nyt-2024`. */
  key: string;
  /** What to call it. The definition text with the bare URL taken out. */
  label: string;
  /** Where it points, when the definition carries a web link. */
  href: string | null;
}

export interface ReportDocument {
  /** The document's own `#` title, when it opens with one. */
  title: string | null;
  headings: ReportHeading[];
  sources: ReportSource[];
  /**
   * The body to render: definitions removed, `[^key]` markers rewritten as
   * `[n](aurora-cite:key)` so the renderer can intercept the click and open the
   * real source. A marker with no definition is left exactly as written — an
   * orphan citation is an error worth seeing, not one worth hiding.
   */
  body: string;
}

/** `aurora-cite:` hrefs are internal — the renderer resolves them, never the browser. */
export const CITE_SCHEME = "aurora-cite:";

const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
const DEFINITION = /^\[\^([^\]\s]{1,64})\]:\s*(.*)$/;
const HEADING = /^(#{1,3})\s+(.*)$/;
const MARKDOWN_LINK = /\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/;
const BARE_URL = /https?:\/\/[^\s<>)\]]+/;

/**
 * Trailing punctuation belongs to the sentence, not to the address. A URL
 * ending in `.` or `,` is a full stop that got swallowed.
 */
const trimUrl = (url: string): string => url.replace(/[.,;:]+$/, "");

/** Pull a link out of a definition, and say what is left over as its name. */
function readDefinition(text: string): { label: string; href: string | null } {
  const linked = MARKDOWN_LINK.exec(text);
  if (linked) {
    const label = linked[1].trim() || trimUrl(linked[2]);
    return { label, href: trimUrl(linked[2]) };
  }
  const bare = BARE_URL.exec(text);
  if (!bare) return { label: text.trim(), href: null };
  const href = trimUrl(bare[0]);
  const label = text.replace(bare[0], "").replace(/[\s—–-]+$/, "").trim();
  return { label: label || href, href };
}

const MARKER = /\[\^([^\]\s]{1,64})\]/g;

export function parseReportDocument(source: string): ReportDocument {
  const lines = source.split(/\r?\n/);
  /** Definitions in the order they were written, keyed so a repeat is ignored. */
  const definitions = new Map<string, { label: string; href: string | null }>();
  const headings: ReportHeading[] = [];
  const bodyLines: string[] = [];
  let title: string | null = null;
  let headingIndex = 0;
  let fence: string | null = null;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    // Inside a fence nothing is a heading and nothing is a definition — a
    // Markdown sample in a report would otherwise rewrite its own contents.
    const fenceMatch = FENCE.exec(line);
    if (fenceMatch) {
      if (!fence) fence = fenceMatch[1][0];
      else if (fenceMatch[1][0] === fence) fence = null;
      bodyLines.push(line);
      continue;
    }
    if (fence) {
      bodyLines.push(line);
      continue;
    }

    const definition = DEFINITION.exec(line);
    if (definition) {
      const [, key, text] = definition;
      if (!definitions.has(key)) definitions.set(key, readDefinition(text));
      // Definitions are lifted out of the body: they are rendered as the
      // source list instead, and leaving them in would print the same list
      // twice — once as Markdown's own footnotes, once as ours.
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      const level = heading[1].length;
      const text = heading[2].trim();
      if (level === 1) {
        if (title === null) title = text;
      } else {
        headings.push({ index: headingIndex, level: level as 2 | 3, text });
        headingIndex += 1;
      }
    }

    bodyLines.push(line);
  }

  const written = bodyLines.join("\n");

  // Numbered by the order the reader MEETS them, not the order they were
  // defined. A source list where [2] appears before [1] reads as a mistake even
  // when every link is right, and the model writes its definitions in whatever
  // order it finished checking them.
  const numbers = new Map<string, number>();
  for (const match of written.matchAll(MARKER)) {
    const key = match[1];
    if (definitions.has(key) && !numbers.has(key)) numbers.set(key, numbers.size + 1);
  }
  // A source defined and never cited still belongs in the list — it is
  // something the author read — and takes its number after the cited ones.
  for (const key of definitions.keys()) {
    if (!numbers.has(key)) numbers.set(key, numbers.size + 1);
  }

  const sources: ReportSource[] = [...definitions.entries()]
    .map(([key, entry]) => ({ n: numbers.get(key) ?? 0, key, ...entry }))
    .sort((left, right) => left.n - right.n);

  const body = written.replace(MARKER, (whole, key: string) => {
    const n = numbers.get(key);
    return n === undefined ? whole : `[${n}](${CITE_SCHEME}${key})`;
  });

  return { title, headings, sources, body };
}
