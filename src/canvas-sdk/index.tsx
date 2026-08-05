/**
 * `aurora/canvas` — the component surface a live canvas is built from.
 *
 * This module never runs in the window. It is transformed at build time and
 * inlined into the canvas sandbox document (see `auroraCanvasRuntime` in
 * `vite.config.ts`), where it becomes the `aurora/canvas` module the agent's
 * compiled source requires.
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
 * nothing and keeps the public surface in one file. */
import { isValidElement, useMemo, useState, type ReactNode } from "react";

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
}

export function Row({ rank, title, description, badge, badgeTone, value, unit }: RowProps) {
  return (
    <li className="ac-row">
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
