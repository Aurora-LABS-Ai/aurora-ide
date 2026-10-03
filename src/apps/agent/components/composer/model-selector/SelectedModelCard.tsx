/**
 * Agent Window — the selected model and its settings, at the top of the model
 * menu [view].
 *
 * Reasoning used to be set from every row of the list at once: each row carried
 * its own switch and effort chip, so a row was five things wide and changing a
 * model you were NOT using looked like part of picking one. Now the settings
 * belong to the model you are on, and the card takes the shape of what that
 * model accepts:
 *
 *   effort model   → one segmented control (Off, then its levels)
 *   budget model   → presets (Off, floor … Max) and a log slider, inline —
 *                    the old popover-on-a-popover is gone
 *   Cursor model   → a Fast switch where a faster twin exists
 *   picture model  → what it does, no controls
 *
 * Every write goes through `updateModel`, the same store path the rows used, so
 * persistence and the send path are unchanged. Like before, it is a property of
 * the MODEL (every chat using it), which the hover text says.
 */

import React, { useState } from "react";

import { AgentIcon } from "@/apps/agent/shared/AgentIcon";
import { AgwSegmented, AgwSwitch } from "@/apps/agent/settings/primitives";
import { reasoningIsOn, useAgentSettingsStore, type LLMModel } from "@/apps/agent/store/settings/useAgentSettingsStore";
import { CURSOR_PROVIDER_ID } from "@/apps/agent/services/providers/cursor";
import { cursorFastAvailable, resolveCursorFast } from "@/apps/agent/services/providers/cursor-run";

import {
  BUDGET_FLOOR,
  budgetPresets,
  budgetRange,
  posToTokens,
  shortTokens,
  tokensToPos,
} from "./budget";
import { levelLabel, type RichOption } from "./model-option";

type Reasoning = NonNullable<LLMModel["reasoning"]>;

const OFF = "__off__";


/** Past this many steps a label column beside the control leaves each step too
 *  narrow for its word ("Medium" at ~56px); the label moves above instead and
 *  the steps take the card's full width. */
const DENSE_STEPS = 4;
const APPLIES_TO_MODEL = "Applies to this model in every chat that uses it.";

// ── Effort ───────────────────────────────────────────────────────────────────

const EffortControl: React.FC<{
  reasoning: Reasoning;
  label: string;
  commit: (next: Reasoning) => void;
}> = ({ reasoning, label, commit }) => {
  const levels = reasoning.levels ?? [];
  const canTurnOff = reasoning.toggleable !== false;
  // "none" is a level some APIs accept; beside an explicit Off it would be the
  // same choice twice.
  const shown = canTurnOff ? levels.filter((l) => l.toLowerCase() !== "none") : levels;
  const current = reasoningIsOn(reasoning)
    ? String(reasoning.default ?? levels[levels.length - 1] ?? "")
    : OFF;

  const options = [
    ...(canTurnOff ? [{ value: OFF, label: "Off" }] : []),
    ...shown.map((level) => ({ value: level, label: levelLabel(level) })),
  ];

  return (
    <div
      className="agw-model-now-ctl"
      data-dense={options.length > DENSE_STEPS || undefined}
      title={APPLIES_TO_MODEL}
    >
      <span className="agw-model-now-lbl">Reasoning</span>
      <div className="agw-model-now-steps">
        <AgwSegmented
          value={current}
          options={options}
          ariaLabel={`Reasoning for ${label}`}
          onChange={(next) =>
            commit(
              next === OFF
                ? { ...reasoning, enabled: false }
                : { ...reasoning, enabled: true, default: next },
            )
          }
        />
      </div>
    </div>
  );
};

// ── Budget ───────────────────────────────────────────────────────────────────

const BudgetControl: React.FC<{
  reasoning: Reasoning;
  maxOutputTokens?: number;
  label: string;
  commit: (next: Reasoning) => void;
}> = ({ reasoning, maxOutputTokens, label, commit }) => {
  const [min, max] = budgetRange(reasoning, maxOutputTokens);
  const on = reasoningIsOn(reasoning);
  const canTurnOff = reasoning.toggleable !== false;
  const raw = typeof reasoning.default === "number" ? reasoning.default : min;
  const stored = Math.min(max, Math.max(min, raw));

  // Live position while the thumb is held. `updateModel` writes through to
  // SQLite on every call and a range emits `change` per step, so committing per
  // step was a database round-trip per pixel. The store is written on release.
  const [draftPos, setDraftPos] = useState<number | null>(null);
  const value = draftPos === null ? stored : posToTokens(draftPos, min, max);
  const pos = draftPos ?? tokensToPos(stored, min, max);

  const setBudget = (next: number) => {
    setDraftPos(null);
    commit({ ...reasoning, enabled: true, default: Math.min(max, Math.max(min, next)) });
  };
  const settle = () => {
    if (draftPos !== null) setBudget(posToTokens(draftPos, min, max));
  };

  // An output cap too small for ANY valid budget: the runtime then omits
  // `thinking` entirely and the model quietly stops reasoning.
  const capTooSmall = typeof maxOutputTokens === "number" && maxOutputTokens <= BUDGET_FLOOR;
  const share =
    typeof maxOutputTokens === "number" && maxOutputTokens > 0
      ? Math.round((value / maxOutputTokens) * 100)
      : null;

  return (
    <>
      <div className="agw-model-now-ctl" title={APPLIES_TO_MODEL}>
        <span className="agw-model-now-lbl">Thinking</span>
        <div className="agw-bud-presets" role="group" aria-label={`Thinking budget for ${label}`}>
          {canTurnOff && (
            <button
              type="button"
              className="agw-bud-preset"
              data-on={!on || undefined}
              aria-pressed={!on}
              onClick={() => commit({ ...reasoning, enabled: false })}
            >
              Off
            </button>
          )}
          {budgetPresets(min, max).map((p) => (
            <button
              key={p.value}
              type="button"
              className="agw-bud-preset"
              data-on={(on && value === p.value) || undefined}
              aria-pressed={on && value === p.value}
              onClick={() => setBudget(p.value)}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>
      {on && (
        <div className="agw-model-now-ctl">
          <span className="agw-model-now-lbl agw-model-now-val">{shortTokens(value)}</span>
          <input
            className="agw-bud-range"
            type="range"
            min={0}
            max={1000}
            step={1}
            value={pos}
            aria-label="Thinking budget in tokens"
            aria-valuetext={`${value.toLocaleString()} tokens`}
            style={{ ["--agw-bud-pct" as string]: `${pos / 10}%` }}
            onChange={(e) => setDraftPos(Number(e.target.value))}
            // Commit once the interaction ends, by whichever route it ends.
            onPointerUp={settle}
            onKeyUp={settle}
            onBlur={settle}
          />
        </div>
      )}
      {(capTooSmall || (on && share !== null)) && (
        <p className="agw-model-now-note" data-tone={capTooSmall ? "warn" : undefined}>
          {capTooSmall
            ? `This model's ${maxOutputTokens!.toLocaleString()}-token output limit leaves no room to think. Raise Max output in provider settings.`
            : `${share}% of its ${shortTokens(maxOutputTokens!)} output limit. Higher budgets think longer and cost more.`}
        </p>
      )}
    </>
  );
};

// ── Card ─────────────────────────────────────────────────────────────────────

export const SelectedModelCard: React.FC<{
  /** The selected model's row, when its provider is ready. */
  opt: RichOption | undefined;
  /** Shown even when `opt` is missing (provider still loading, key cleared). */
  label: string;
  providerName: string;
  fastOn: boolean;
  onFastChange: (next: boolean) => void;
}> = ({ opt, label, providerName, fastOn, onFastChange }) => {
  const updateModel = useAgentSettingsStore((s) => s.updateModel);
  const reasoning = opt?.reasoning;

  const commit = (next: Reasoning) => {
    if (!opt?.id) return;
    // A reasoning choice with no Fast twin turns Fast off rather than leaving a
    // preference on that the next turn cannot honour.
    if (
      opt.providerId === CURSOR_PROVIDER_ID &&
      fastOn &&
      !cursorFastAvailable({ modelKey: opt.model, reasoning: next })
    ) {
      onFastChange(false);
    }
    updateModel(opt.id, { reasoning: next });
  };

  const fast =
    opt?.providerId === CURSOR_PROVIDER_ID
      ? resolveCursorFast({ modelKey: opt.model, reasoning: opt.reasoning })
      : null;
  const showFast = fast !== null && (fast.ok || fastOn);

  return (
    <div className="agw-model-now">
      <div className="agw-model-now-top">
        <span className="agw-model-now-name" title={opt && opt.model !== label ? opt.model : undefined}>
          {label}
        </span>
        {providerName && <span className="agw-model-now-prov">{providerName}</span>}
        <span className="agw-model-now-caps">
          {opt?.vision && <AgentIcon name="eye" size={13} title="Accepts image input" />}
          {opt?.tools && <AgentIcon name="shield" size={13} title="Supports tool calling" />}
          {opt?.image && <AgentIcon name="image" size={13} title="Makes pictures" />}
        </span>
      </div>

      {/* Deliberately no claim about editing an attached picture: the direct
          path (`image_direct_generate`) only generates today, even for models
          whose provider can edit. Say what it does, not what the model could. */}
      {opt?.image && <p className="agw-model-now-note">Replies with a picture. Reads no history.</p>}

      {reasoning && opt?.id && reasoning.type === "effort" && (reasoning.levels?.length ?? 0) > 0 && (
        <EffortControl reasoning={reasoning} label={label} commit={commit} />
      )}
      {reasoning && opt?.id && reasoning.type === "budget" && (
        <BudgetControl
          reasoning={reasoning}
          maxOutputTokens={opt.maxOutputTokens}
          label={label}
          commit={commit}
        />
      )}

      {showFast && (
        <div className="agw-model-now-ctl">
          <span className="agw-model-now-lbl">Fast</span>
          <span className="agw-model-now-hint" data-tone={!fast?.ok ? "warn" : undefined}>
            {fast?.ok
              ? "Answers sooner, on your Cursor plan's faster lane."
              : "Not available with this reasoning setting."}
          </span>
          <AgwSwitch
            checked={fastOn && !!fast?.ok}
            ariaLabel={`Fast mode for ${label}`}
            // Unavailable but still on: the switch is how it gets turned off.
            onChange={(next) => onFastChange(fast?.ok ? next : false)}
          />
        </div>
      )}
    </div>
  );
};
