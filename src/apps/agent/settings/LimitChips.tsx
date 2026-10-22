/**
 * Agent Window — one-click values under a token-limit field.
 *
 * Context windows and output caps come in a handful of sizes, and typing
 * 262000 by hand is where a zero goes missing. The chip whose value is already
 * in the field shows as picked, so the row also reads back what is set.
 */

import React from "react";

import { formatTokenChip } from "./limit-chips";

export const LimitChips: React.FC<{
  /** What the chips set, for screen readers: "context window". */
  label: string;
  values: readonly number[];
  current: number | undefined;
  onPick: (tokens: number) => void;
}> = ({ label, values, current, onPick }) => (
  <div className="agw-limit-chips" role="group" aria-label={`Common ${label} sizes`}>
    {values.map((tokens) => (
      <button
        key={tokens}
        type="button"
        className="agw-limit-chip"
        aria-pressed={current === tokens}
        title={`Set ${label} to ${tokens.toLocaleString()} tokens`}
        onClick={() => onPick(tokens)}
      >
        {formatTokenChip(tokens)}
      </button>
    ))}
  </div>
);
