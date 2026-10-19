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

import React, { useId, useRef, useState } from "react";

import type { FlowStep } from "@/apps/agent/lib/reply-layout/parse";
import { Field } from "./Field";

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

export const FlowSteps: React.FC<{ steps: FlowStep[] }> = ({ steps }) => {
  const [chosen, setChosen] = useState(0);
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const baseId = useId();
  // Steps keep arriving while the reply streams; a choice past the end falls back.
  const open = Math.min(chosen, steps.length - 1);
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
      </div>
    );
  }

  const choose = (i: number) => {
    setChosen(i);
    tabs.current[i]?.focus();
  };
  const onKeyDown = (event: React.KeyboardEvent) => {
    const last = steps.length - 1;
    const next =
      event.key === "ArrowRight" ? (open === last ? 0 : open + 1)
      : event.key === "ArrowLeft" ? (open === 0 ? last : open - 1)
      : event.key === "Home" ? 0
      : event.key === "End" ? last
      : null;
    if (next === null) return;
    event.preventDefault();
    choose(next);
  };

  return (
    <div className="agw-rl agw-rl-flow">
      <div className="agw-rl-steps" role="tablist" aria-label="Steps" onKeyDown={onKeyDown}>
        {steps.map((step, i) => (
          // The arrow travels with the step it points at, so a wrapped line
          // never ends on a bare arrow.
          <span key={i} className="agw-rl-step-cell">
            {i > 0 && <span className="agw-rl-step-arrow" aria-hidden="true">→</span>}
            <button
              ref={(el) => {
                tabs.current[i] = el;
              }}
              type="button"
              role="tab"
              id={`${baseId}-tab-${i}`}
              aria-selected={i === open}
              aria-controls={`${baseId}-panel`}
              tabIndex={i === open ? 0 : -1}
              className="agw-rl-step"
              data-branches={step.items.length > 1 ? step.items.length : undefined}
              onClick={() => setChosen(i)}
            >
              <span className="agw-rl-step-n" aria-hidden="true">{i + 1}</span>
              <StepName step={step} />
            </button>
          </span>
        ))}
      </div>
      <div className="agw-rl-step-detail" role="tabpanel" id={`${baseId}-panel`} aria-labelledby={`${baseId}-tab-${open}`}>
        <StepDetail step={steps[open]} />
      </div>
    </div>
  );
};
