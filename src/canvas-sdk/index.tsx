/**
 * `aurora/canvas` — the component surface a live canvas is built from.
 *
 * It runs in two places. It is transformed at build time and inlined into the
 * canvas sandbox document (see `auroraCanvasRuntime` in `vite.config.ts`),
 * where it becomes the `aurora/canvas` module the agent's compiled source
 * requires. And the Agent Window imports it directly to draw an answer box
 * (`components/answer-box/`), so a box in a reply and a canvas in the dock are
 * built from the same parts. SDK modules use local imports and `react` only;
 * the library build bundles the local modules and keeps React external.
 *
 * ## Why these components and not others
 *
 * The first canvases the agent produced by hand were twelve near-identical
 * bordered cards in one column, each with a decorative coloured left edge —
 * two of the patterns the authoring guide explicitly forbids, written by a
 * model that had just read that guide. Prose does not constrain output;
 * available components do.
 *
 * So the surface is shaped by what it REFUSES to offer:
 *
 * - **There is no generic `Card`.** Grouping is done by whitespace and a
 *   hairline (`Section`, `List`) because that is what the doctrine asks for
 *   and because a `Card` in the toolbox becomes a `Card` around everything.
 * - **No `style` or `className` props.** A component cannot be talked into a
 *   gradient, a shadow, or a second accent. Raw elements remain available for
 *   the genuinely unusual case; the escape hatch is deliberately less
 *   convenient than the right answer.
 * - **Labels are required, not optional.** `Stat` cannot render a number
 *   without saying what it measures; `Table` cannot render without a caption.
 *   An unlabelled figure is not a finding.
 * - **Empty renders nothing.** `Section`, `List`, `Stats`, and `Table` return
 *   `null` rather than an empty frame, which makes "never render an empty
 *   state" structurally true instead of aspirational.
 *
 * Every colour is an `--agw-*` token read live from the host, so a canvas
 * follows the user's theme with no work from the agent.
 */
/* eslint-disable react-refresh/only-export-components --
 * Fast Refresh never applies here: this module is not part of the window's
 * component tree. It is transformed at build time and executed inside the
 * canvas sandbox, so `useHostTheme` sitting beside the components costs
 * nothing and keeps components and hooks on the same public entry. */
import {
  isValidElement,
  useId,
  useMemo,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import "./canvas.css";
export { Report } from "./reporting/Report";
export { Chart } from "./reporting/Chart";
export { DataTable } from "./reporting/DataTable";
export { Metric, MetricGrid } from "./reporting/Metric";
export { SearchField, SelectField, MultiSelect, RangeField, Toggle } from "./reporting/Controls";
export type { ReportSpec, ReportBlock, ReportSection, ChartSpec, ChartKind, DataColumn, DataRecord, ValueFormat, ReportFilter } from "./reporting/types";

/**
 * Semantic emphasis. Deliberately small: one accent hue plus real status.
 *
 * A tone sets `--ac-tone` on the element, and every component that shows
 * colour paints from that one variable — so a `warn` badge, a `warn` bar and a
 * `warn` stat are the same amber, and adding a component does not mean picking
 * colours again.
 */
export type Tone = "neutral" | "info" | "good" | "warn" | "bad";

const toneClass = (tone: Tone | undefined): string => `ac-tone-${tone ?? "neutral"}`;

/** Clamp a fraction into 0–1 so a bad denominator cannot draw off the track. */
const ratio = (value: number, max: number): number => {
  if (!Number.isFinite(value) || !Number.isFinite(max) || max <= 0) return 0;
  return Math.min(1, Math.max(0, value / max));
};

/* ------------------------------------------------------------------ frame */

export interface CanvasProps {
  /** What this canvas is. Becomes the page's only `h1`. */
  title: string;
  /** One line of context under the title. Optional. */
  subtitle?: string;
  /**
   * Where the numbers came from and over what period — "Datadog · last 7
   * days", "repo scan at HEAD". Findings without provenance are opinions.
   */
  source?: string;
  children?: ReactNode;
}

export function Canvas({ title, subtitle, source, children }: CanvasProps) {
  return (
    <main className="ac-canvas">
      <header className="ac-canvas-head">
        <h1>{title}</h1>
        {subtitle ? <p className="ac-canvas-sub">{subtitle}</p> : null}
        {source ? <p className="ac-canvas-source">{source}</p> : null}
      </header>
      {children}
    </main>
  );
}

export interface SectionProps {
  title?: string;
  /** One line on what the section shows or why it matters. */
  description?: string;
  children?: ReactNode;
}

/** Grouping by whitespace and rhythm. Renders nothing when it has nothing. */
export function Section({ title, description, children }: SectionProps) {
  if (isEmpty(children)) return null;
  return (
    <section className="ac-section">
      {title ? <h2>{title}</h2> : null}
      {description ? <p className="ac-section-desc">{description}</p> : null}
      <div className="ac-section-body">{children}</div>
    </section>
  );
}

/* ------------------------------------------------------------------- rows */

export interface ListProps {
  children?: ReactNode;
}

/** A ranked or itemised list. Rows are separated by a hairline, not boxed. */
export function List({ children }: ListProps) {
  if (isEmpty(children)) return null;
  return <ul className="ac-list">{children}</ul>;
}

export interface RowProps {
  /** Position in a ranking. Shown as a quiet ordinal, not a badge. */
  rank?: number;
  title: string;
  description?: string;
  /** Short qualifier — a category, a type, a status. */
  badge?: string;
  badgeTone?: Tone;
  /** The measured quantity this row is ranked or compared by. */
  value?: string | number;
  /** Unit for `value`. A bare number is not a measurement. */
  unit?: string;
  /**
   * The row that answers the question — "Each pays", "Total". One per list:
   * a list where every row is emphasised has no answer in it.
   */
  emphasis?: boolean;
}

export function Row({ rank, title, description, badge, badgeTone, value, unit, emphasis }: RowProps) {
  return (
    <li className={emphasis ? "ac-row ac-row-strong" : "ac-row"}>
      {rank === undefined ? null : <span className="ac-row-rank">{rank}</span>}
      <div className="ac-row-main">
        <span className="ac-row-title">{title}</span>
        {description ? <span className="ac-row-desc">{description}</span> : null}
      </div>
      <div className="ac-row-trail">
        {badge ? <Badge tone={badgeTone}>{badge}</Badge> : null}
        {value === undefined ? null : (
          <span className="ac-row-value">
            <span className="ac-num">{format(value)}</span>
            {unit ? <span className="ac-row-unit">{unit}</span> : null}
          </span>
        )}
      </div>
    </li>
  );
}

/* ------------------------------------------------------------------ stats */

export interface StatProps {
  /** What the number measures. Required — an unlabelled figure says nothing. */
  label: string;
  value: string | number;
  /** Unit or denominator: "ms", "files", "% of total". */
  unit?: string;
  /** Comparison or caveat: "vs 412 last week", "p95". */
  note?: string;
  tone?: Tone;
}

export function Stat({ label, value, unit, note, tone }: StatProps) {
  return (
    <div className={`ac-stat ${toneClass(tone)}`}>
      <span className="ac-stat-label">{label}</span>
      <span className="ac-stat-value">
        <span className="ac-num">{format(value)}</span>
        {unit ? <span className="ac-stat-unit">{unit}</span> : null}
      </span>
      {note ? <span className="ac-stat-note">{note}</span> : null}
    </div>
  );
}

export function Stats({ children }: { children?: ReactNode }) {
  if (isEmpty(children)) return null;
  return <div className="ac-stats">{children}</div>;
}

/* ------------------------------------------------------------------ table */

export interface TableColumn {
  /** Key into each row object. */
  key: string;
  /**
   * Column heading. Include the unit here: "Size (KB)". `label` is accepted
   * as a synonym — the two names are equally natural and being wrong about
   * which one this API chose should not cost a render.
   */
  header?: string;
  label?: string;
  /**
   * Override alignment. Left by default; columns whose values are all numbers
   * are detected and right-aligned without being told.
   */
  align?: "left" | "right";
  /** Force numeric treatment when a column's values are numeric strings. */
  numeric?: boolean;
  /**
   * Force sorting off. Sorting is already disabled automatically for columns
   * whose cells are components, since there is nothing to compare.
   */
  sortable?: boolean;
}

/**
 * Anything React can render. Cells hold components on purpose — a path wants
 * `<code>`, a category wants `<Badge>`, a proportion wants a bar. A table that
 * only took strings would push every one of those back into hand-built markup.
 */
export type TableCell = ReactNode;

export interface TableProps {
  /**
   * What this table shows, and where it came from. Required: a table a reader
   * has to reverse-engineer is not a deliverable.
   */
  caption: string;
  columns: TableColumn[];
  rows: Array<Record<string, TableCell>>;
}

/** The heading text, whichever of the two names the caller used. */
const headingOf = (column: TableColumn, index: number): string => {
  const heading = column.header ?? column.label;
  if (typeof heading === "string" && heading.length > 0) return heading;
  throw new Error(
    `Table columns[${index}] (key "${column.key}") has no heading. ` +
      `Give it \`header: "…"\`. An unlabelled column tells the reader nothing.`,
  );
};

/** Values a cell can be compared by. Components are not sortable. */
const sortValueOf = (cell: TableCell): string | number | null => {
  if (cell === null || cell === undefined || cell === "") return null;
  if (typeof cell === "number" || typeof cell === "string") return cell;
  return null;
};

const isRenderableCell = (cell: TableCell): boolean =>
  cell === null ||
  cell === undefined ||
  typeof cell === "string" ||
  typeof cell === "number" ||
  typeof cell === "boolean" ||
  isValidElement(cell) ||
  Array.isArray(cell);

/**
 * A sortable table — the thing a chat transcript genuinely cannot do.
 *
 * Sorting is the only interaction, and it is signposted: every header is a
 * real button with `aria-sort`, so it is reachable by keyboard and announced
 * by a screen reader rather than being a click target you have to guess at.
 */
export function Table({ caption, columns, rows }: TableProps) {
  const [sort, setSort] = useState<{ key: string; descending: boolean } | null>(null);

  /**
   * What each column IS, worked out from its data rather than declared.
   *
   * Requiring `numeric: true` and `disableSort` meant every column carried two
   * flags the data already answers — and getting either wrong produced a table
   * that rendered but lied. Inference removes the question: a column of numbers
   * right-aligns and sorts numerically, a column of components does not pretend
   * to be sortable.
   */
  const resolved = useMemo(
    () =>
      columns.map((column, index) => {
        const values = rows.map((row) => row[column.key]);
        const present = values.filter((value) => value !== null && value !== undefined && value !== "");
        const numeric =
          column.numeric ??
          (present.length > 0 &&
            present.every((value) => typeof value === "number" || (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value)))));
        const comparable = present.some((value) => sortValueOf(value) !== null);
        return {
          key: column.key,
          heading: headingOf(column, index),
          numeric,
          align: column.align ?? (numeric ? "right" : "left"),
          sortable: column.sortable ?? comparable,
        };
      }),
    [columns, rows],
  );

  const ordered = useMemo(() => {
    if (!sort) return rows;
    const column = resolved.find((entry) => entry.key === sort.key);
    const direction = sort.descending ? -1 : 1;
    return [...rows].sort((left, right) => {
      const a = sortValueOf(left[sort.key]);
      const b = sortValueOf(right[sort.key]);
      // Absent values sort last in both directions: a gap is not a low score.
      if (a === null) return 1;
      if (b === null) return -1;
      if (column?.numeric) return (Number(a) - Number(b)) * direction;
      return String(a).localeCompare(String(b)) * direction;
    });
  }, [resolved, rows, sort]);

  if (rows.length === 0 || columns.length === 0) return null;

  return (
    <figure className="ac-table-wrap">
      <table className="ac-table">
        <caption>{caption}</caption>
        <thead>
          <tr>
            {resolved.map((column) => {
              const active = sort?.key === column.key;
              return (
                <th
                  key={column.key}
                  scope="col"
                  data-align={column.align}
                  aria-sort={
                    !column.sortable
                      ? undefined
                      : active
                        ? sort.descending
                          ? "descending"
                          : "ascending"
                        : "none"
                  }
                >
                  {column.sortable ? (
                    <button
                      type="button"
                      onClick={() =>
                        setSort((current) =>
                          current?.key === column.key
                            ? { key: column.key, descending: !current.descending }
                            : { key: column.key, descending: column.numeric },
                        )
                      }
                    >
                      <span>{column.heading}</span>
                      <span className="ac-sort" aria-hidden="true">
                        {active ? (sort.descending ? "↓" : "↑") : "↕"}
                      </span>
                    </button>
                  ) : (
                    <span className="ac-th-static">{column.heading}</span>
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {ordered.map((row, index) => (
            <tr key={index}>
              {resolved.map((column) => {
                const cell = row[column.key];
                const absent = cell === null || cell === undefined || cell === "";
                if (!absent && !isRenderableCell(cell)) {
                  // Rendering it would print "[object Object]" — a silent lie.
                  throw new Error(
                    `Table row ${index} column "${column.key}" is a plain object. ` +
                      `A cell must be a string, a number, or a component such as <code>, <Badge>, or <Text>.`,
                  );
                }
                return (
                  <td key={column.key} data-align={column.align}>
                    {absent ? (
                      // A bare em-dash reads as breakage. Name the absence.
                      <span className="ac-absent" title="Not recorded">
                        not recorded
                      </span>
                    ) : typeof cell === "string" || typeof cell === "number" ? (
                      <span className={column.numeric ? "ac-num" : undefined}>{format(cell)}</span>
                    ) : (
                      cell
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}

/* ------------------------------------------------------------------- text */

export function Badge({ children, tone }: { children: ReactNode; tone?: Tone }) {
  return <span className={`ac-badge ${toneClass(tone)}`}>{children}</span>;
}

/** A short aside: a caveat, a definition, a consequence. */
export function Note({ children, tone }: { children: ReactNode; tone?: Tone }) {
  return <p className={`ac-note ${toneClass(tone)}`}>{children}</p>;
}

export function Text({ children, muted }: { children: ReactNode; muted?: boolean }) {
  return <p className={muted ? "ac-text ac-text-muted" : "ac-text"}>{children}</p>;
}

/** Inline identifier — a path, a symbol, a flag. */
export function Code({ children }: { children: ReactNode }) {
  return <code className="ac-code">{children}</code>;
}

/* ------------------------------------------------------------- research */

/**
 * Open a link from inside the sandbox.
 *
 * The frame runs on `sandbox="allow-scripts"` — no `allow-popups`, no
 * `allow-top-navigation` — so an ordinary `<a target="_blank">` is silently
 * inert. A citation you can click and nothing happens is worse than a citation
 * that is plainly not a link, so the href is handed to the host, which opens it
 * in the user's real browser. Same channel the frame already uses to report a
 * crash (`CanvasReact`'s message listener).
 */
function openFromSandbox(href: string): void {
  try {
    window.parent.postMessage({ source: "aurora-canvas", type: "open-url", href }, "*");
  } catch {
    // A frame with no parent (a test, a preview) simply does not navigate.
  }
}

export interface ImageProps {
  /** Where the picture is. A local asset path or an http(s) URL. */
  src: string;
  /**
   * What the picture SHOWS. Required for the same reason `Stat` requires a
   * label: a picture nobody can describe is decoration, and a reader who cannot
   * see it gets nothing at all.
   */
  alt: string;
  /** One line under the picture — what to notice in it. */
  caption?: string;
  /** Where it came from: a site, a dataset, the prompt that generated it. */
  source?: string;
}

/**
 * A picture, with its caption and its provenance.
 *
 * **A missing file says so.** An image whose source cannot be loaded renders a
 * named absence carrying the path, never a broken-image glyph and never
 * nothing: a generated asset can be deleted, and a report that quietly loses a
 * figure is a report that lies about what it showed.
 */
export function Image({ src, alt, caption, source }: ImageProps) {
  const [failed, setFailed] = useState(false);
  if (!src) return null;
  return (
    <figure className="ac-figure">
      {failed ? (
        <div className="ac-figure-missing" role="img" aria-label={`${alt} — file not found`}>
          <span className="ac-figure-missing-title">File not found</span>
          <span className="ac-figure-missing-src">{src}</span>
        </div>
      ) : (
        <img
          className="ac-figure-img"
          src={src}
          alt={alt}
          loading="lazy"
          onError={() => setFailed(true)}
        />
      )}
      {caption || source ? (
        <figcaption className="ac-figure-cap">
          {caption ? <span className="ac-figure-caption">{caption}</span> : null}
          {source ? <span className="ac-figure-source">{source}</span> : null}
        </figcaption>
      ) : null}
    </figure>
  );
}

export interface CiteProps {
  /**
   * This source's number in this canvas. Supplied rather than counted: the SDK
   * holds no state between components, and a number that silently renumbered
   * itself on a re-render would make the same claim point at two sources.
   */
  n: number;
  /** Where the claim came from. */
  href: string;
  /** The source's name. Becomes the tooltip and the link's accessible name. */
  children?: ReactNode;
}

/**
 * A numbered citation, inline after the claim it supports.
 *
 * `Canvas` and `BarChart` already take a `source` string, which says where a
 * whole page or chart came from. This is the other half: one specific claim,
 * one specific source, and a way to go and read it.
 */
export function Cite({ n, href, children }: CiteProps) {
  const label = typeof children === "string" ? children : "";
  return (
    <sup className="ac-cite">
      <button
        type="button"
        title={label || href}
        aria-label={label ? `Source ${n}: ${label}` : `Source ${n}`}
        onClick={() => openFromSandbox(href)}
      >
        [{n}]
      </button>
    </sup>
  );
}

export interface QuoteProps {
  /** The passage, in the source's own words. */
  children: ReactNode;
  /**
   * Who or what said it. Required — an unattributed quotation is just text in
   * a different typeface, and the whole point of pulling it out is that someone
   * else is answerable for it.
   */
  from: string;
  /** Exactly where: a page, a section, a timestamp. */
  where?: string;
  /** The source, if it can be reached. */
  href?: string;
}

/** A passage from somewhere else, kept visibly separate from your own prose. */
export function Quote({ children, from, where, href }: QuoteProps) {
  if (isEmpty(children)) return null;
  return (
    <figure className="ac-quote">
      <blockquote>{children}</blockquote>
      <figcaption>
        {href ? (
          <button type="button" className="ac-quote-from" onClick={() => openFromSandbox(href)}>
            {from}
          </button>
        ) : (
          <span className="ac-quote-from">{from}</span>
        )}
        {where ? <span className="ac-quote-where">{where}</span> : null}
      </figcaption>
    </figure>
  );
}

/* ---------------------------------------------------------------- measure */

export interface BarProps {
  value: number;
  /** The total this value is a part of. Without it there is no proportion. */
  max: number;
  tone?: Tone;
  /**
   * What the bar represents, for anyone not reading it visually. Defaults to
   * the value and total, which is better than nothing but worse than a name.
   */
  label?: string;
}

/**
 * A proportion, as a track and a fill.
 *
 * Exists because the first canvas that wanted one hand-built it from two
 * nested `<div style={…}>` — which works, but means every ranking invents its
 * own bar geometry, colour, and rounding.
 */
export function Bar({ value, max, tone, label }: BarProps) {
  const fraction = ratio(value, max);
  return (
    <span
      className={`ac-bar ${toneClass(tone)}`}
      role="img"
      aria-label={label ?? `${format(value)} of ${format(max)}`}
    >
      <span className="ac-bar-fill" style={{ width: `${(fraction * 100).toFixed(1)}%` }} />
    </span>
  );
}

export interface BarChartDatum {
  label: string;
  value: number;
  tone?: Tone;
}

export interface BarChartProps {
  /** Name the measure, not the topic: "Lines of code by file". */
  title: string;
  /** Unit for every value: "lines", "ms", "requests". */
  unit?: string;
  /** Where the numbers came from, and over what period. */
  source?: string;
  data: BarChartDatum[];
}

/**
 * Ranked horizontal bars — the honest default chart for "which of these is
 * biggest". Scaled against the largest value, so bar length is comparable
 * across rows and nothing is exaggerated by a cropped axis.
 */
export function BarChart({ title, unit, source, data }: BarChartProps) {
  const max = useMemo(() => Math.max(0, ...data.map((entry) => entry.value)), [data]);
  if (data.length === 0) return null;
  return (
    <figure className="ac-chart">
      <figcaption className="ac-chart-head">
        <span className="ac-chart-title">
          {title}
          {unit ? <span className="ac-chart-unit"> ({unit})</span> : null}
        </span>
        {source ? <span className="ac-chart-source">{source}</span> : null}
      </figcaption>
      <div className="ac-chart-rows">
        {data.map((entry) => (
          <div className="ac-chart-row" key={entry.label}>
            <span className="ac-chart-label" title={entry.label}>
              {entry.label}
            </span>
            <Bar
              value={entry.value}
              max={max}
              tone={entry.tone}
              label={`${entry.label}: ${format(entry.value)}${unit ? ` ${unit}` : ""}`}
            />
            <span className="ac-chart-value ac-num">{format(entry.value)}</span>
          </div>
        ))}
      </div>
    </figure>
  );
}

export interface SparklineProps {
  values: number[];
  tone?: Tone;
  /** What the trend is of — required for the same reason axes are labelled. */
  label: string;
}

/** An inline trend. Too small for axes, so it never pretends to be precise. */
export function Sparkline({ values, tone, label }: SparklineProps) {
  const path = useMemo(() => {
    if (values.length < 2) return "";
    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = max - min || 1;
    return values
      .map((value, index) => {
        const x = (index / (values.length - 1)) * 100;
        const y = 20 - ((value - min) / span) * 18 - 1;
        return `${index === 0 ? "M" : "L"}${x.toFixed(2)} ${y.toFixed(2)}`;
      })
      .join(" ");
  }, [values]);

  if (!path) return null;
  return (
    <svg
      className={`ac-spark ${toneClass(tone)}`}
      viewBox="0 0 100 20"
      preserveAspectRatio="none"
      role="img"
      aria-label={`${label}: ${values.length} points, ${format(values[0])} to ${format(values[values.length - 1])}`}
    >
      <path d={path} fill="none" stroke="currentColor" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/* ------------------------------------------------------------- structure */

export function Facts({ children }: { children?: ReactNode }) {
  if (isEmpty(children)) return null;
  return <dl className="ac-facts">{children}</dl>;
}

/** One labelled value. The shape for "field: value" detail, not a table. */
export function Fact({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="ac-fact">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

/** Side-by-side on a wide panel, stacked when it is narrow. */
export function Columns({ children }: { children?: ReactNode }) {
  if (isEmpty(children)) return null;
  return <div className="ac-columns">{children}</div>;
}

export function Divider() {
  return <hr className="ac-divider" />;
}

/**
 * Progressive disclosure — the long evidence behind a short claim.
 *
 * A real `<details>`, so it is keyboard-operable and searchable by the browser
 * without any state of ours.
 */
export function Detail({ summary, children }: { summary: string; children?: ReactNode }) {
  if (isEmpty(children)) return null;
  return (
    <details className="ac-detail">
      <summary>{summary}</summary>
      <div className="ac-detail-body">{children}</div>
    </details>
  );
}

export interface TabsProps {
  tabs: Array<{ id: string; label: string; content: ReactNode }>;
}

/** Grouping for content that competes for the same space. */
export function Tabs({ tabs }: TabsProps) {
  const [active, setActive] = useState(tabs[0]?.id);
  if (tabs.length === 0) return null;
  const current = tabs.find((tab) => tab.id === active) ?? tabs[0];
  return (
    <div className="ac-tabs">
      <div className="ac-tablist" role="tablist">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            id={`tab-${tab.id}`}
            aria-selected={tab.id === current.id}
            aria-controls={`panel-${tab.id}`}
            data-active={tab.id === current.id || undefined}
            onClick={() => setActive(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div
        className="ac-tabpanel"
        role="tabpanel"
        id={`panel-${current.id}`}
        aria-labelledby={`tab-${current.id}`}
      >
        {current.content}
      </div>
    </div>
  );
}

export interface PickerItem {
  id: string;
  label: string;
  /** One short line under the label. */
  caption?: string;
}

export interface PickerProps {
  /** What the choice is of, read by assistive tech. */
  label: string;
  items: PickerItem[];
  /** The chosen id. Omit to let the picker keep its own choice, starting at the first item. */
  value?: string;
  onChange?: (id: string) => void;
}

/**
 * A grid of a few named things to choose between, one chosen at a time, for a
 * canvas whose detail below changes with the choice. Not a wall of cards: the
 * items are small, the chosen one is marked by its line and weight, and the
 * grid exists only because something else reads the choice.
 */
export function Picker({ label, items, value, onChange }: PickerProps) {
  const [own, setOwn] = useState(items[0]?.id);
  if (items.length === 0) return null;
  const chosen = value ?? own;
  const choose = (id: string) => {
    setOwn(id);
    onChange?.(id);
  };
  return (
    <div className="ac-picker" role="radiogroup" aria-label={label}>
      {items.map((item) => {
        const active = item.id === chosen;
        return (
          <button
            key={item.id}
            type="button"
            role="radio"
            aria-checked={active}
            className="ac-picker-item"
            data-active={active || undefined}
            onClick={() => choose(item.id)}
          >
            <span className="ac-picker-label">{item.label}</span>
            {item.caption ? <span className="ac-picker-caption">{item.caption}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

export function Timeline({ children }: { children?: ReactNode }) {
  if (isEmpty(children)) return null;
  return <ol className="ac-timeline">{children}</ol>;
}

export function Event({
  when,
  title,
  description,
  tone,
}: {
  when: string;
  title: string;
  description?: string;
  tone?: Tone;
}) {
  return (
    <li className={`ac-event ${toneClass(tone)}`}>
      <span className="ac-event-when">{when}</span>
      <span className="ac-event-title">{title}</span>
      {description ? <span className="ac-event-desc">{description}</span> : null}
    </li>
  );
}

/* ----------------------------------------------------------------- inputs */

/**
 * State that is the caller's when it passes `value`, and the component's own
 * when it does not. A canvas can drop a `<Stepper>` in with a `defaultValue`
 * and read nothing back; a page that computes from it passes `value` and
 * `onChange` and owns the number.
 */
function useControllable<T>(
  value: T | undefined,
  defaultValue: T,
  onChange: ((next: T) => void) | undefined,
): [T, (next: T) => void] {
  const [own, setOwn] = useState(defaultValue);
  const controlled = value !== undefined;
  const current = controlled ? value : own;
  const set = (next: T) => {
    if (!controlled) setOwn(next);
    onChange?.(next);
  };
  return [current, set];
}

/** Decimal places in a step, so 0.1 + 0.2 lands on 0.3 and not 0.30000000000000004. */
const decimalsOf = (step: number): number => {
  const text = String(step);
  const dot = text.indexOf(".");
  return dot === -1 ? 0 : text.length - dot - 1;
};

/** "person/people" → the right word for the number; a plain unit passes through. */
const unitFor = (unit: string | undefined, value: number): string | undefined => {
  if (!unit) return undefined;
  const slash = unit.indexOf("/");
  if (slash === -1) return unit;
  return value === 1 ? unit.slice(0, slash) : unit.slice(slash + 1);
};

export interface StepperProps {
  /** What the number counts. Required, like every input's label. */
  label: string;
  value?: number;
  defaultValue?: number;
  onChange?: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  /** "kg", or "person/people" to follow the number. */
  unit?: string;
  /**
   * `large` is for the ONE input a tool turns on: the number takes the centre
   * and the buttons sit at the edges. Everything else stays `default`, a row
   * with its label on the left.
   */
  size?: "default" | "large";
}

/**
 * A whole number you change with − and +, or with the arrow keys on the
 * number itself (Page Up/Down move five steps, Home/End jump to the ends).
 * The buttons disable at the limits rather than doing nothing.
 */
export function Stepper({
  label,
  value,
  defaultValue,
  onChange,
  min = 0,
  max = 1_000_000,
  step = 1,
  unit,
  size = "default",
}: StepperProps) {
  const start = Math.min(max, Math.max(min, defaultValue ?? min));
  const [current, setCurrent] = useControllable(value, start, onChange);
  const places = decimalsOf(step);
  const go = (next: number) => {
    const clamped = Math.min(max, Math.max(min, Number(next.toFixed(places))));
    if (clamped !== current) setCurrent(clamped);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    const moves: Record<string, number> = {
      ArrowUp: step,
      ArrowRight: step,
      ArrowDown: -step,
      ArrowLeft: -step,
      PageUp: step * 5,
      PageDown: -step * 5,
    };
    if (event.key in moves) go(current + moves[event.key]);
    else if (event.key === "Home") go(min);
    else if (event.key === "End") go(max);
    else return;
    event.preventDefault();
  };
  const word = unitFor(unit, current);
  const minus = (
    <button
      type="button"
      className="ac-step-btn"
      aria-label={`Decrease ${label}`}
      disabled={current <= min}
      onClick={() => go(current - step)}
    >
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path d="M3.5 8h9" />
      </svg>
    </button>
  );
  const plus = (
    <button
      type="button"
      className="ac-step-btn"
      aria-label={`Increase ${label}`}
      disabled={current >= max}
      onClick={() => go(current + step)}
    >
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path d="M8 3.5v9M3.5 8h9" />
      </svg>
    </button>
  );
  const number = (
    <span
      className="ac-step-value ac-num"
      role="spinbutton"
      tabIndex={0}
      aria-label={label}
      aria-valuenow={current}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuetext={word ? `${format(current)} ${word}` : undefined}
      onKeyDown={onKeyDown}
    >
      {format(current)}
    </span>
  );

  if (size === "large") {
    return (
      <div className="ac-stepper-large">
        <span className="ac-field-label">{label}</span>
        <div className="ac-stepper-hero">
          {minus}
          <span className="ac-stepper-mid">
            {number}
            {word ? <span className="ac-stepper-unit">{word}</span> : null}
          </span>
          {plus}
        </div>
      </div>
    );
  }
  return (
    <div className="ac-field">
      <span className="ac-field-label">{label}</span>
      <span className="ac-stepper">
        {minus}
        {number}
        {plus}
        {word ? <span className="ac-stepper-unit">{word}</span> : null}
      </span>
    </div>
  );
}

export interface NumberFieldProps {
  label: string;
  value?: number;
  defaultValue?: number;
  onChange?: (value: number) => void;
  min?: number;
  max?: number;
  /** Shown before the number, inside the field: "$". */
  prefix?: string;
  /** Shown after it: "kg", "%". */
  suffix?: string;
}

/**
 * A typed number. While what is typed is not a number in range, the field
 * says why underneath and keeps reporting the last good value — so whatever
 * is computed from it never flips to NaN mid-keystroke.
 */
export function NumberField({
  label,
  value,
  defaultValue,
  onChange,
  min,
  max,
  prefix,
  suffix,
}: NumberFieldProps) {
  const id = useId();
  const [current, setCurrent] = useControllable(value, defaultValue ?? 0, onChange);
  const [text, setText] = useState(() => String(current));
  const [error, setError] = useState<string | null>(null);
  // A value changed from outside (a reset) replaces what was typed.
  const [seen, setSeen] = useState(current);
  if (seen !== current) {
    setSeen(current);
    if (Number(text.replace(/[,\s]/g, "")) !== current) setText(String(current));
  }
  const onInput = (raw: string) => {
    setText(raw);
    const cleaned = raw.replace(/[,\s]/g, "").replace(prefix ?? "", "");
    const parsed = cleaned === "" ? Number.NaN : Number(cleaned);
    let problem: string | null = null;
    if (!Number.isFinite(parsed)) problem = cleaned === "" ? "Enter a number." : "That isn't a number.";
    else if (min !== undefined && parsed < min) problem = `It can't be less than ${format(min)}.`;
    else if (max !== undefined && parsed > max) problem = `It can't be more than ${format(max)}.`;
    setError(problem);
    if (!problem && parsed !== current) {
      setSeen(parsed);
      setCurrent(parsed);
    }
  };
  return (
    <div className="ac-field">
      <label className="ac-field-label" htmlFor={id}>
        {label}
      </label>
      <span className="ac-number" data-invalid={error ? "" : undefined}>
        {prefix ? <span className="ac-number-affix">{prefix}</span> : null}
        <input
          id={id}
          className="ac-num"
          inputMode="decimal"
          value={text}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-error` : undefined}
          onChange={(event) => onInput(event.target.value)}
        />
        {suffix ? <span className="ac-number-affix">{suffix}</span> : null}
      </span>
      {error ? (
        <span className="ac-field-error" id={`${id}-error`}>
          {error}
        </span>
      ) : null}
    </div>
  );
}

export interface ChoiceOption {
  label: string;
  value: string | number;
}

export interface ChoiceProps {
  label: string;
  /** Two to five. Past that it is a list to pick from, not a choice. */
  options: ChoiceOption[];
  value?: string | number;
  defaultValue?: string | number;
  onChange?: (value: string | number) => void;
}

/**
 * One of a few options, side by side. A real radio group: the arrow keys move
 * the choice, and the chosen option is told apart by its fill AND its weight.
 */
export function Choice({ label, options, value, defaultValue, onChange }: ChoiceProps) {
  const [current, setCurrent] = useControllable<string | number>(
    value,
    defaultValue ?? options[0]?.value ?? "",
    onChange,
  );
  if (options.length === 0) return null;
  const index = Math.max(
    0,
    options.findIndex((option) => option.value === current),
  );
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const delta =
      event.key === "ArrowRight" || event.key === "ArrowDown"
        ? 1
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? -1
          : 0;
    if (delta === 0) return;
    event.preventDefault();
    const next = (index + delta + options.length) % options.length;
    setCurrent(options[next].value);
    const buttons = event.currentTarget.querySelectorAll<HTMLButtonElement>("button");
    buttons[next]?.focus();
  };
  return (
    <div className="ac-field">
      <span className="ac-field-label">{label}</span>
      <div className="ac-choice" role="radiogroup" aria-label={label} onKeyDown={onKeyDown}>
        {options.map((option, i) => (
          <button
            key={String(option.value)}
            type="button"
            role="radio"
            aria-checked={i === index}
            tabIndex={i === index ? 0 : -1}
            onClick={() => setCurrent(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ theme */

export interface HostTheme {
  conversation: string;
  surface: string;
  surfaceElevated: string;
  text: string;
  textMuted: string;
  textSubtle: string;
  border: string;
  borderStrong: string;
  accent: string;
  good: string;
  warn: string;
  bad: string;
  fontUi: string;
  fontCode: string;
}

/**
 * The window's live theme as values, for the rare case a raw element needs a
 * colour. Reach for a component first — hard-coding `#1a1a1a` looks broken the
 * moment the user switches to a light theme.
 */
export function useHostTheme(): HostTheme {
  return useMemo(() => {
    const styles = getComputedStyle(document.documentElement);
    const token = (name: string, fallback: string) =>
      styles.getPropertyValue(name).trim() || fallback;
    return {
      conversation: token("--agw-conversation", "#0f0f0f"),
      surface: token("--agw-surface", "#1d1d1d"),
      surfaceElevated: token("--agw-surface-elevated", "#2e2e2e"),
      text: token("--agw-text", "#ededed"),
      textMuted: token("--agw-text-muted", "#a0a0a0"),
      textSubtle: token("--agw-text-subtle", "#727272"),
      border: token("--agw-border", "#222222"),
      borderStrong: token("--agw-border-strong", "#383838"),
      accent: token("--agw-accent", "#3994bc"),
      good: token("--agw-added", "#73c991"),
      warn: token("--agw-warning", "#e5ba7d"),
      bad: token("--agw-removed", "#f48771"),
      fontUi: token("--agw-font-ui", "system-ui, sans-serif"),
      fontCode: token("--agw-font-code", "ui-monospace, monospace"),
    };
  }, []);
}

/* ----------------------------------------------------------------- helpers */

/** Thousands separators on bare numbers; strings pass through untouched. */
function format(value: string | number): string {
  return typeof value === "number" && Number.isFinite(value)
    ? value.toLocaleString()
    : String(value);
}

/**
 * Whether children amount to nothing renderable. `[]`, `null`, and `false`
 * are all how "no data" arrives from a `.map()` or a `&&`, and each one must
 * collapse the container rather than leave an empty frame behind.
 */
function isEmpty(children: ReactNode): boolean {
  if (children === null || children === undefined || children === false) return true;
  return Array.isArray(children) && children.filter(Boolean).length === 0;
}
