/**
 * Agent Window — one parsed reply layout block, drawn [view].
 *
 * Shared by the two ways a block reaches a reply: its own fence
 * (`ReplyLayout`, kept so old chats still draw) and a row part of the reply
 * language (`UiReply`). Both parse rows with the same parsers, so both draw
 * through here and cannot drift apart.
 */

import React from "react";

import type { Bar, Fact, NoteLine, Pair, ReplyLayout } from "@/apps/agent/lib/reply-layout/parse";
import { Field } from "./Field";
import { FlowSteps } from "./FlowSteps";
import { StructuredLayouts } from "./StructuredLayouts";
import { Report } from "@/canvas-sdk/reporting/Report";

/**
 * Rows, not tiles. The first build drew a grid of bordered tiles with big
 * values; live, six of them with the model's real values ("PostgreSQL via
 * Prisma 7.3", a caption carrying `next.config.ts:39`) wrapped at six
 * different heights and read as a dashboard pasted into a chat (Alvan,
 * 2026-10-15: "so much cheap looks"). A list in one quiet frame is the
 * transcript's own shape — the answer box's rows, the turn summary — and
 * takes any length without changing what it is.
 */
const Facts: React.FC<{ title: string; facts: Fact[] }> = ({ title, facts }) => (
  <div className="agw-rl agw-rl-facts">
    {title && (
      <div className="agw-rl-block-title">
        <Field text={title} />
      </div>
    )}
    <dl className="agw-rl-facts-list">
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
  </div>
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

export const LayoutBody: React.FC<{ layout: ReplyLayout }> = ({ layout }) => (
  <>
    {layout.kind === "facts" && <Facts title={layout.title} facts={layout.facts} />}
    {layout.kind === "flow" && <FlowSteps steps={layout.steps} />}
    {layout.kind === "note" && <Note title={layout.title} lines={layout.lines} />}
    {layout.kind === "bars" && <Bars title={layout.title} bars={layout.bars} />}
    {layout.kind === "pairs" && <Pairs title={layout.title} pairs={layout.pairs} />}
    {layout.kind === "report" && layout.spec && <Report spec={layout.spec} />}
    {(layout.kind === "compare" || layout.kind === "checklist" || layout.kind === "timeline" || layout.kind === "tree") && (
      <StructuredLayouts layout={layout} />
    )}
  </>
);

/** Problems past this are counted, not listed. */
const MAX_LISTED_PROBLEMS = 3;

/** The lines a block skipped, named under it. */
export const LayoutProblems: React.FC<{ problems: string[]; label?: string }> = ({ problems, label = "Lines this block skipped" }) =>
  problems.length === 0 ? null : (
    <ul className="agw-rl-problems" aria-label={label}>
      {problems.slice(0, MAX_LISTED_PROBLEMS).map((problem, i) => (
        <li key={i}>{problem}</li>
      ))}
      {problems.length > MAX_LISTED_PROBLEMS && <li>and {problems.length - MAX_LISTED_PROBLEMS} more</li>}
    </ul>
  );
