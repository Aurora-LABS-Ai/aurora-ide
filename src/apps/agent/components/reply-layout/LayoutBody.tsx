/**
 * Agent Window — one parsed reply layout block, drawn [view].
 *
 * Shared by the two ways a block reaches a reply: its own fence
 * (`ReplyLayout`, kept so old chats still draw) and a row part of the reply
 * language (`UiReply`). Both parse rows with the same parsers, so both draw
 * through here and cannot drift apart.
 */

import React, { useState } from "react";

import type { Bar, Fact, NoteLine, Pair, ReplyLayout } from "@/apps/agent/lib/reply-layout/parse";
import { AgentIcon } from "@/apps/agent/shared/AgentIcon";
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
/** What a block draws as the last thing inside its own card (its skipped lines). */
type Foot = { foot?: React.ReactNode };

const Facts: React.FC<{ title: string; facts: Fact[] } & Foot> = ({ title, facts, foot }) => (
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
    {foot}
  </div>
);

const Note: React.FC<{ title: string; lines: NoteLine[] } & Foot> = ({ title, lines, foot }) => (
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
    {foot}
  </aside>
);

/**
 * Bars: a share, a count against a total, a progression. The number is always
 * printed beside the bar (colour never carries a value alone); the fill is the
 * accent at reduced strength, no glow, no gradient.
 */
const Bars: React.FC<{ title: string; bars: Bar[] } & Foot> = ({ title, bars, foot }) => (
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
    {foot}
  </div>
);

/** Pairs: a titled key / value table. The note is for a caveat; this is a lookup. */
const Pairs: React.FC<{ title: string; pairs: Pair[] } & Foot> = ({ title, pairs, foot }) => (
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
    {foot}
  </dl>
);

/**
 * One block. `problems` are the lines it skipped, drawn at the bottom INSIDE
 * its card: pooled under the last card of a reply, a checklist's bad row was
 * listed under a timeline, prefixed with the part's name (Alvan, 2026-10-24).
 * Pass them only once the block is finished; a half-written line is no fault.
 */
export const LayoutBody: React.FC<{ layout: ReplyLayout; problems?: string[] }> = ({ layout, problems = [] }) => {
  const foot = problems.length > 0 && (
    <div className="agw-rl-card-foot">
      <LayoutProblems problems={problems} />
    </div>
  );
  return (
    <>
      {layout.kind === "facts" && <Facts title={layout.title} facts={layout.facts} foot={foot} />}
      {layout.kind === "flow" && <FlowSteps steps={layout.steps} foot={foot} />}
      {layout.kind === "note" && <Note title={layout.title} lines={layout.lines} foot={foot} />}
      {layout.kind === "bars" && <Bars title={layout.title} bars={layout.bars} foot={foot} />}
      {layout.kind === "pairs" && <Pairs title={layout.title} pairs={layout.pairs} foot={foot} />}
      {/* A report draws its own SDK card; its problems follow it. */}
      {layout.kind === "report" && layout.spec && <Report spec={layout.spec} />}
      {layout.kind === "report" && problems.length > 0 && <LayoutProblems problems={problems} label="Report errors" />}
      {(layout.kind === "compare" || layout.kind === "checklist" || layout.kind === "timeline" || layout.kind === "tree") && (
        <StructuredLayouts layout={layout} foot={foot} />
      )}
    </>
  );
};

/** "row — reason" → the two halves; the reason never holds " — ", the row may. */
function splitProblem(problem: string): { row: string; reason: string } {
  const at = problem.lastIndexOf(" — ");
  return at < 0 ? { row: "", reason: problem } : { row: problem.slice(0, at), reason: problem.slice(at + 3) };
}

/**
 * The lines a block skipped, folded under it as one quiet line. The reasons
 * are written for the model ("write a pipe inside text as \|"); spread open
 * in the warning colour under every block they drowned the reply they were
 * annotating (Alvan, 2026-10-24). Folded, they stay findable without shouting.
 */
export const LayoutProblems: React.FC<{ problems: string[]; label?: string }> = ({ problems, label = "Lines this block skipped" }) => {
  const [open, setOpen] = useState(false);
  if (problems.length === 0) return null;
  const count = `${problems.length} ${problems.length === 1 ? "line" : "lines"} skipped`;
  return (
    <div className="agw-rl-problems">
      <button type="button" className="agw-rl-problems-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        <AgentIcon name="chevron-right" size={12} className="agw-rl-problems-chev" />
        {count}
      </button>
      <ul className="agw-rl-problems-list" aria-label={label} hidden={!open}>
        {problems.map((problem, i) => {
          const { row, reason } = splitProblem(problem);
          return (
            <li key={i}>
              {row && <code className="agw-rl-problems-row">{row}</code>}
              <span className="agw-rl-problems-reason">{reason}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
};
