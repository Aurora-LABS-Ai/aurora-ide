/**
 * Agent Window — a comparison [view].
 *
 * Three or more aspects draw one aspect at a time: aspect tabs, then each
 * option's value side by side, so a long comparison reads as a few short
 * decisions instead of a dense grid. The last tab, All, keeps the full table
 * one press away — hiding the at-a-glance view entirely would make the
 * trade-offs harder to weigh, not easier. One or two aspects stay the table.
 */

import React from "react";

import type { ComparisonRow } from "@/apps/agent/lib/reply-layout/structures";
import { Field } from "./Field";
import { useRovingTabs } from "./useRovingTabs";

const ASPECTS_FROM = 3;

interface CompareProps {
  title: string;
  heading: string;
  options: string[];
  rows: ComparisonRow[];
}

const CompareTable: React.FC<CompareProps & { caption: boolean }> = ({ title, heading, options, rows, caption }) => (
  <table role="table" aria-label={title && caption ? undefined : title || "Comparison"}>
    {title && caption && <caption className="agw-rl-block-title"><Field text={title} /></caption>}
    <thead role="rowgroup">
      <tr role="row">
        <th role="columnheader" scope="col"><Field text={heading} /></th>
        {options.map((option, i) => <th key={i} role="columnheader" scope="col"><Field text={option} /></th>)}
      </tr>
    </thead>
    <tbody role="rowgroup">
      {rows.map((row, i) => (
        <tr key={i} role="row">
          <th role="rowheader" scope="row"><Field text={row.label} /></th>
          {row.values.map((value, j) => (
            <td key={j} role="cell">
              <span className="agw-rl-compare-option" aria-hidden="true"><Field text={options[j]} /></span>
              <span><Field text={value} /></span>
            </td>
          ))}
        </tr>
      ))}
    </tbody>
  </table>
);

export const CompareAspects: React.FC<CompareProps & { foot?: React.ReactNode }> = ({ foot, ...props }) => {
  const { title, heading, options, rows } = props;
  const { open, onKeyDown, tab, panel } = useRovingTabs(rows.length + 1);

  if (rows.length < ASPECTS_FROM) {
    return (
      <div className="agw-rl agw-rl-structure agw-rl-compare">
        <CompareTable {...props} caption />
        {foot}
      </div>
    );
  }

  const row = rows[open];
  return (
    <section className="agw-rl agw-rl-structure agw-rl-compare" data-stepped="" aria-label={title || "Comparison"}>
      {title && <div className="agw-rl-block-title"><Field text={title} /></div>}
      <div className="agw-rl-pills" role="tablist" aria-label={heading || "Aspect"} onKeyDown={onKeyDown}>
        {rows.map((aspect, i) => (
          <button key={i} {...tab(i)} className="agw-rl-pill">
            <Field text={aspect.label} />
          </button>
        ))}
        <button {...tab(rows.length)} className="agw-rl-pill">All</button>
      </div>
      <div className="agw-rl-compare-pane" {...panel}>
        {row ? (
          <dl className="agw-rl-compare-cols" style={{ "--agw-rl-cols": options.length } as React.CSSProperties}>
            {options.map((option, j) => (
              <div key={j} className="agw-rl-compare-col">
                <dt className="agw-rl-compare-name"><Field text={option} /></dt>
                <dd className="agw-rl-compare-value"><Field text={row.values[j] ?? ""} /></dd>
              </div>
            ))}
          </dl>
        ) : (
          <CompareTable {...props} caption={false} />
        )}
      </div>
      {foot}
    </section>
  );
};
