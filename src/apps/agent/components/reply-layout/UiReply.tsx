/**
 * Agent Window — an `aurora-ui` fence: a whole laid-out answer [view].
 *
 * The parts arrive line by line (`lib/reply-layout/ui.ts`); each draws the
 * moment its line ends, in the order the root names. Row parts draw through
 * `LayoutBody`, the same code the single-block fences use; stats use the
 * reporting SDK's metric marks; the diagram is the one part with its own
 * component.
 */

import React, { useMemo } from "react";

import { parseUi, uiIsEmpty, type UiPart, type UiStat } from "@/apps/agent/lib/reply-layout/ui";
import { Field } from "./Field";
import { LayoutBody, LayoutProblems } from "./LayoutBody";
import { Diagram } from "./Diagram";
import { LinkCard, SourceChips } from "./Links";

/** The reporting SDK's metric grid, with values as the model wrote them. */
const Stats: React.FC<{ stats: UiStat[] }> = ({ stats }) => (
  <dl className="ac-metric-grid agw-rl-stats">
    {stats.map((stat, i) => (
      <div key={i} className="ac-metric ac-tone-neutral">
        <dt className="ac-metric-label">
          <Field text={stat.label} />
        </dt>
        <dd className="ac-metric-value">
          <Field text={stat.value} />
        </dd>
        {stat.note && (
          <dd className="ac-metric-note">
            <Field text={stat.note} />
          </dd>
        )}
      </div>
    ))}
  </dl>
);

const Part: React.FC<{ part: UiPart; closed: boolean }> = ({ part, closed }) => {
  switch (part.kind) {
    case "title":
      return (
        <h3 className="agw-rl-ui-title">
          <Field text={part.text} />
        </h3>
      );
    case "text":
      return (
        <p className="agw-rl-ui-text">
          <Field text={part.text} />
        </p>
      );
    case "stats":
      return <Stats stats={part.stats} />;
    case "diagram":
      return <Diagram title={part.title} columns={part.columns} edges={part.edges} />;
    case "link":
      return <LinkCard title={part.title} source={part.source} caption={part.caption} badge={part.badge} />;
    case "sources":
      return <SourceChips sources={part.sources} />;
    case "block":
      return (
        <div data-kind={part.layout.kind}>
          {part.heading && (
            <div className="agw-rl-ui-heading">
              <Field text={part.heading} />
            </div>
          )}
          <LayoutBody layout={part.layout} problems={closed ? part.layout.problems : undefined} />
        </div>
      );
  }
};

export const UiReply: React.FC<{
  source: string;
  closed: boolean;
  fallback: React.ReactNode;
}> = ({ source, closed, fallback }) => {
  const layout = useMemo(() => parseUi(source, closed), [source, closed]);

  if (uiIsEmpty(layout)) {
    if (!closed) return <div className="agw-rl agw-rl-pending" aria-hidden="true" />;
    return (
      <>
        {fallback}
        <LayoutProblems problems={layout.problems} label="Lines this layout skipped" />
      </>
    );
  }

  return (
    <div className="agw-rl-wrap agw-rl-ui" data-kind="ui">
      {layout.parts.map((part) => (
        <div key={part.key} className="agw-rl-ui-part">
          <Part part={part} closed={closed} />
        </div>
      ))}
      {/* Only problems no drawn block owns: an unknown part, a name never placed. */}
      {closed && <LayoutProblems problems={layout.problems} label="Lines this layout skipped" />}
    </div>
  );
};
