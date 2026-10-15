/**
 * Agent Window — a reply layout block: facts, a flow, or a note, drawn inline
 * in a reply [view].
 *
 * Transcript → Reply layout (opt-in). The model writes one of three fences
 * (`lib/reply-layout/parse.ts`); this draws it between the sentences around
 * it, at the transcript's own type scale and on the canvas card's surface, so
 * a laid-out reply and a plain one read as one product.
 *
 * Nothing here is interactive and nothing is saved: these are page parts, not
 * tools. The answer box (`components/answer-box`) is the tool. A line the
 * block could not read is named under it, the same way a box names its
 * skipped lines; a block with nothing drawable falls back to its source as
 * code, so the reader always sees what the model wrote.
 */

import React, { useMemo } from "react";

import {
  inlineRuns,
  layoutIsEmpty,
  parseLayout,
  type Bar,
  type Fact,
  type FlowStep,
  type LayoutLanguage,
  type NoteLine,
  type Pair,
} from "@/apps/agent/lib/reply-layout/parse";

/** Problems past this are counted, not listed. */
const MAX_LISTED_PROBLEMS = 3;

/** A field: text with `code` spans. */
const Field: React.FC<{ text: string }> = ({ text }) => (
  <>
    {inlineRuns(text).map((run, i) =>
      run.kind === "code" ? <code key={i}>{run.text}</code> : <React.Fragment key={i}>{run.text}</React.Fragment>,
    )}
  </>
);

/**
 * Rows, not tiles. The first build drew a grid of bordered tiles with big
 * values; live, six of them with the model's real values ("PostgreSQL via
 * Prisma 7.3", a caption carrying `next.config.ts:39`) wrapped at six
 * different heights and read as a dashboard pasted into a chat (Alvan,
 * 2026-10-15: "so much cheap looks"). A list in one quiet frame is the
 * transcript's own shape — the answer box's rows, the turn summary — and
 * takes any length without changing what it is.
 */
const Facts: React.FC<{ facts: Fact[] }> = ({ facts }) => (
  <dl className="agw-rl agw-rl-facts">
    {facts.map((fact, i) => (
      <div key={i} className="agw-rl-fact">
        <dt className="agw-rl-fact-label">
          <Field text={fact.label} />
        </dt>
        <dd className="agw-rl-fact-body">
          <span className="agw-rl-fact-value">
            <Field text={fact.value} />
          </span>
          {fact.caption && (
            <span className="agw-rl-fact-caption">
              <Field text={fact.caption} />
            </span>
          )}
        </dd>
      </div>
    ))}
  </dl>
);

/**
 * A stepper, not stacked boxes. The first build drew each step as a bordered
 * node inside a bordered frame with an arrow between; seven of them on the
 * model's real content were seven grey boxes in a grey box (Alvan,
 * 2026-10-15: "still trash"). A rail with a dot per step is the transcript's
 * own timeline shape, carries the order without arrows, and leaves the words
 * as the loudest thing. Branches share one line, separated by a middle dot.
 */
const Flow: React.FC<{ steps: FlowStep[] }> = ({ steps }) => (
  <ol className="agw-rl agw-rl-flow">
    {steps.map((step, i) =>
      step.items.length > 1 ? (
        <li key={i} className="agw-rl-step" data-branches={step.items.length}>
          <div className="agw-rl-branches">
            {step.items.map((item, j) => (
              <span key={j} className="agw-rl-branch">
                <span className="agw-rl-node-title">
                  <Field text={item.title} />
                </span>
                {item.caption && (
                  <span className="agw-rl-node-caption">
                    <Field text={item.caption} />
                  </span>
                )}
              </span>
            ))}
          </div>
        </li>
      ) : (
        <li key={i} className="agw-rl-step">
          <div className="agw-rl-node-title">
            <Field text={step.items[0].title} />
          </div>
          {step.items[0].caption && (
            <div className="agw-rl-node-caption">
              <Field text={step.items[0].caption} />
            </div>
          )}
        </li>
      ),
    )}
  </ol>
);

const Note: React.FC<{ title: string; lines: NoteLine[] }> = ({ title, lines }) => (
  <aside className="agw-rl agw-rl-note">
    {/* No icon: the rule on the left is the mark, and a glyph would say
        "warning" about what is often just a detail worth knowing. */}
    {title && (
      <div className="agw-rl-note-title">
        <Field text={title} />
      </div>
    )}
    {lines.map((line, i) =>
      line.kind === "pair" ? (
        <div key={i} className="agw-rl-pair">
          <span className="agw-rl-pair-label">
            <Field text={line.label} />
          </span>
          <span className="agw-rl-pair-value">
            <Field text={line.value} />
          </span>
        </div>
      ) : (
        <p key={i} className="agw-rl-note-text">
          <Field text={line.text} />
        </p>
      ),
    )}
  </aside>
);

/**
 * Bars: a share, a count against a total, a progression. The number is always
 * printed beside the bar (colour never carries a value alone); the fill is the
 * accent at reduced strength, no glow, no gradient.
 */
const Bars: React.FC<{ title: string; bars: Bar[] }> = ({ title, bars }) => (
  <div className="agw-rl agw-rl-bars">
    {title && (
      <div className="agw-rl-block-title">
        <Field text={title} />
      </div>
    )}
    {bars.map((bar, i) => {
      const ratio = bar.max > 0 ? Math.max(0, Math.min(1, bar.value / bar.max)) : 0;
      return (
        <div key={i} className="agw-rl-bar">
          <div className="agw-rl-bar-head">
            <span className="agw-rl-bar-label">
              <Field text={bar.label} />
            </span>
            <span className="agw-rl-bar-amount">{bar.shown}</span>
          </div>
          <div className="agw-rl-bar-track" role="img" aria-label={`${bar.label}: ${bar.shown}`}>
            <div className="agw-rl-bar-fill" style={{ width: `${(ratio * 100).toFixed(1)}%` }} />
          </div>
          {bar.caption && (
            <div className="agw-rl-bar-caption">
              <Field text={bar.caption} />
            </div>
          )}
        </div>
      );
    })}
  </div>
);

/** Pairs: a titled key / value table. The note is for a caveat; this is a lookup. */
const Pairs: React.FC<{ title: string; pairs: Pair[] }> = ({ title, pairs }) => (
  <dl className="agw-rl agw-rl-pairs">
    {title && (
      <div className="agw-rl-block-title">
        <Field text={title} />
      </div>
    )}
    {pairs.map((pair, i) => (
      <div key={i} className="agw-rl-pair">
        <dt className="agw-rl-pair-label">
          <Field text={pair.label} />
        </dt>
        <dd className="agw-rl-pair-value">
          <Field text={pair.value} />
        </dd>
      </div>
    ))}
  </dl>
);

export const ReplyLayout: React.FC<{
  language: LayoutLanguage;
  source: string;
  /** The closing fence has arrived (or the turn is over). */
  closed: boolean;
  /** Drawn instead when the block holds nothing to draw: the source as code. */
  fallback: React.ReactNode;
}> = ({ language, source, closed, fallback }) => {
  const layout = useMemo(() => parseLayout(language, source, closed), [language, source, closed]);

  if (layoutIsEmpty(layout)) {
    // Streaming and nothing complete yet: hold the space quietly rather than
    // flashing the raw fence for a frame.
    return closed ? <>{fallback}</> : <div className="agw-rl agw-rl-pending" aria-hidden="true" />;
  }

  // Problems only once the block is finished: a half-written line is not a fault.
  const problems = closed ? layout.problems : [];

  return (
    <div className="agw-rl-wrap" data-kind={layout.kind}>
      {layout.kind === "facts" && <Facts facts={layout.facts} />}
      {layout.kind === "flow" && <Flow steps={layout.steps} />}
      {layout.kind === "note" && <Note title={layout.title} lines={layout.lines} />}
      {layout.kind === "bars" && <Bars title={layout.title} bars={layout.bars} />}
      {layout.kind === "pairs" && <Pairs title={layout.title} pairs={layout.pairs} />}
      {problems.length > 0 && (
        <ul className="agw-rl-problems" aria-label="Lines this block skipped">
          {problems.slice(0, MAX_LISTED_PROBLEMS).map((problem, i) => (
            <li key={i}>{problem}</li>
          ))}
          {problems.length > MAX_LISTED_PROBLEMS && <li>and {problems.length - MAX_LISTED_PROBLEMS} more</li>}
        </ul>
      )}
    </div>
  );
};
