/**
 * Agent Window — a flow, across: step names left to right, the chosen step's
 * caption underneath [view].
 *
 * Probe `Documents/aurora-flow-shape-designs.html`, card 03 (Alvan's pick,
 * 2026-10-16). The flow used to be a rail top to bottom with every caption
 * open; three flows of four or five steps in one live answer were a wall of
 * 579px for two of them, and he did not want it vertical. Across with one
 * caption open drew the same two in 284px.
 *
 * The trade, chosen knowingly: one caption is read at a time. A flow whose
 * steps carry no captions has nothing to open, so it draws as a plain path
 * with no controls. The choice is view state only — never saved, never sent.
 */

import React from "react";

import type { FlowStep } from "@/apps/agent/lib/reply-layout/parse";
import { Field } from "./Field";
import { useRovingTabs } from "./useRovingTabs";

const StepName: React.FC<{ step: FlowStep }> = ({ step }) => (
  <>
    {step.items.map((item, j) => (
      <React.Fragment key={j}>
        {j > 0 && <span className="agw-rl-step-or"> · </span>}
        <Field text={item.title} />
      </React.Fragment>
    ))}
  </>
);

/** What the open step says: its caption, or each branch's when it splits. */
const StepDetail: React.FC<{ step: FlowStep }> = ({ step }) =>
  step.items.length === 1 ? (
    step.items[0].caption ? <Field text={step.items[0].caption} /> : null
  ) : (
    <ul className="agw-rl-step-branches">
      {step.items.map((item, j) => (
        <li key={j}>
          <span className="agw-rl-step-branch-name">
            <Field text={item.title} />
          </span>
          {item.caption && (
            <>
              {" "}
              <Field text={item.caption} />
            </>
          )}
        </li>
      ))}
    </ul>
  );

export const FlowSteps: React.FC<{ steps: FlowStep[]; foot?: React.ReactNode }> = ({ steps, foot }) => {
  const { open, onKeyDown, tab, panel } = useRovingTabs(steps.length);
  const hasDetail = steps.some((step) => step.items.some((item) => item.caption));

  if (!hasDetail) {
    return (
      <div className="agw-rl agw-rl-flow" data-plain="">
        <ol className="agw-rl-steps">
          {steps.map((step, i) => (
            <li key={i} className="agw-rl-step">
              {i > 0 && <span className="agw-rl-step-arrow" aria-hidden="true">→</span>}
              <span className="agw-rl-step-n" aria-hidden="true">{i + 1}</span>
              <StepName step={step} />
            </li>
          ))}
        </ol>
        {foot}
      </div>
    );
  }

  return (
    <div className="agw-rl agw-rl-flow">
      <div className="agw-rl-steps" role="tablist" aria-label="Steps" onKeyDown={onKeyDown}>
        {steps.map((step, i) => (
          // The arrow travels with the step it points at, so a wrapped line
          // never ends on a bare arrow.
          <span key={i} className="agw-rl-step-cell">
            {i > 0 && <span className="agw-rl-step-arrow" aria-hidden="true">→</span>}
            <button
              {...tab(i)}
              className="agw-rl-step"
              data-branches={step.items.length > 1 ? step.items.length : undefined}
            >
              <span className="agw-rl-step-n" aria-hidden="true">{i + 1}</span>
              <StepName step={step} />
            </button>
          </span>
        ))}
      </div>
      <div className="agw-rl-step-detail" {...panel}>
        <StepDetail step={steps[open]} />
      </div>
      {foot}
    </div>
  );
};
