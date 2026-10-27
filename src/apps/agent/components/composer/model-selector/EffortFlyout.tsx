/**
 * Agent Window — one model's reasoning choices, beside the model menu [view].
 *
 * Opened from a row's `›`, by resting on the row, or with →. Choosing a line
 * sets the model's reasoning and picks the model, so "Opus 5 at Max" is one
 * choice instead of pick-then-adjust. Cursor's Fast lane sits under the list
 * as a switch: it is a setting, not a pick.
 *
 * Positioned by the selector (`placeFlyout`), outside the menu box, because
 * the menu clips its own overflow.
 */

import React from "react";

import { AgentIcon } from "@/apps/agent/shared/AgentIcon";
import { AgwSwitch } from "@/apps/agent/settings/primitives";

import { effortTier, type ReasoningChoice } from "./model-settings";

export interface FlyoutFast {
  /** Fast can run with the reasoning chosen now. */
  available: boolean;
  on: boolean;
  onChange: (next: boolean) => void;
}

export const EffortFlyout = React.forwardRef<
  HTMLDivElement,
  {
    /** DOM id prefix; option `i` is `${idBase}-${i}`. */
    idBase: string;
    modelLabel: string;
    choices: ReasoningChoice[];
    /** The line the arrow keys (or the pointer) are on; `choices.length` is the Fast line. */
    activeIndex: number;
    fast: FlyoutFast | null;
    position: { left: number; top: number } | null;
    onPoint: (index: number) => void;
    onChoose: (index: number) => void;
    onEnter: () => void;
  }
>(({ idBase, modelLabel, choices, activeIndex, fast, position, onPoint, onChoose, onEnter }, ref) => (
  <div
    ref={ref}
    role="listbox"
    aria-label={`Reasoning for ${modelLabel}`}
    className="agw-menu agw-model-fly"
    // Measured before it is shown, so it never flashes at the wrong spot.
    style={position ? { left: position.left, top: position.top } : { visibility: "hidden", left: 0, top: 0 }}
    onMouseEnter={onEnter}
    onClick={(e) => e.stopPropagation()}
  >
    <div className="agw-model-fly-title">Reasoning</div>
    {choices.map((choice, i) => (
      <div
        key={choice.key}
        id={`${idBase}-${i}`}
        role="option"
        aria-selected={choice.current}
        className="agw-model-fly-row"
        data-kbd-active={i === activeIndex || undefined}
        onMouseEnter={() => onPoint(i)}
        onClick={() => onChoose(i)}
      >
        <span className="agw-model-fly-label" data-effort={effortTier(choice.label)}>
          {choice.label}
        </span>
        {choice.current && <AgentIcon name="check" size={14} className="agw-model-check" />}
      </div>
    ))}
    {fast && (
      <div
        id={`${idBase}-${choices.length}`}
        className="agw-model-fly-fast"
        data-kbd-active={activeIndex === choices.length || undefined}
        onMouseEnter={() => onPoint(choices.length)}
        title={
          fast.available
            ? "Answers sooner, on your Cursor plan's faster lane."
            : "Not available with this reasoning setting."
        }
      >
        <span>Fast</span>
        <AgwSwitch
          checked={fast.on && fast.available}
          ariaLabel={`Fast mode for ${modelLabel}`}
          // Unavailable but still on: the switch is how it gets turned off.
          onChange={(next) => fast.onChange(fast.available ? next : false)}
        />
      </div>
    )}
  </div>
));
EffortFlyout.displayName = "EffortFlyout";
