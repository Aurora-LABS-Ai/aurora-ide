/**
 * Agent Window — a timeline's events [view].
 *
 * Three or more events draw as date tabs with one event open under them and
 * Previous / Next to walk the order, the same "one open at a time" shape the
 * flow already uses (2026-10-23, from a ChatGPT redraw of an Aurora reply
 * Alvan liked: "intelligent, not static"). One or two events have nothing to
 * walk, so they stay the dated list.
 */

import React from "react";

import type { TimelineItem } from "@/apps/agent/lib/reply-layout/structures";
import { Field } from "./Field";
import { useRovingTabs } from "./useRovingTabs";

const STEP_FROM = 3;

const DatedList: React.FC<{ items: TimelineItem[] }> = ({ items }) => (
  <ol className="agw-rl-dated-list" role="list">
    {items.map((item, i) => (
      <li key={i} className="agw-rl-dated-row">
        <span className="agw-rl-date"><Field text={item.when} /></span>
        <div className="agw-rl-item-body">
          <div className="agw-rl-node-title"><Field text={item.title} /></div>
          {item.caption && <div className="agw-rl-node-caption"><Field text={item.caption} /></div>}
        </div>
      </li>
    ))}
  </ol>
);

export const TimelineEvents: React.FC<{ items: TimelineItem[]; label: string }> = ({ items, label }) => {
  const { open, select, onKeyDown, tab, panel } = useRovingTabs(items.length);
  if (items.length < STEP_FROM) return <DatedList items={items} />;

  const item = items[open];
  const atStart = open === 0;
  const atEnd = open === items.length - 1;
  return (
    <>
      <div className="agw-rl-pills" role="tablist" aria-label={label} onKeyDown={onKeyDown}>
        {items.map((event, i) => (
          <button key={i} {...tab(i)} className="agw-rl-pill">
            <Field text={event.when} />
          </button>
        ))}
      </div>
      <div className="agw-rl-pane" {...panel}>
        <div className="agw-rl-pane-head">
          <span className="agw-rl-date"><Field text={item.when} /></span>
          <span className="agw-rl-count">{open + 1} of {items.length}</span>
        </div>
        <div className="agw-rl-node-title"><Field text={item.title} /></div>
        {item.caption && <div className="agw-rl-pane-text"><Field text={item.caption} /></div>}
        {/* aria-disabled, not disabled: a disabled button drops focus to the
            page when the reader reaches the last event with the keyboard. */}
        <div className="agw-rl-pager">
          <button
            type="button"
            className="agw-rl-pager-btn"
            aria-disabled={atStart}
            onClick={() => !atStart && select(open - 1)}
          >
            <span aria-hidden="true">←</span> Previous
          </button>
          <button
            type="button"
            className="agw-rl-pager-btn"
            aria-disabled={atEnd}
            onClick={() => !atEnd && select(open + 1)}
          >
            Next <span aria-hidden="true">→</span>
          </button>
        </div>
      </div>
    </>
  );
};
