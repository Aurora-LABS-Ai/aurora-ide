/**
 * Agent Window — Settings · Team (view).
 *
 * The dedicated home for the Agent Team: a virtual engineering team that plans,
 * splits the project by scope, and runs peer workers under one lead you chat
 * with. This page owns everything team-shaped — enablement, size ceiling, the
 * team model, and (soon) recent runs.
 * All controls read/write the shared `useAgentSettingsStore` so the IDE and this
 * window stay in lockstep. Reads `--agw-*` tokens exclusively.
 */

import React, { useMemo } from "react";

import {
  useAgentSettingsStore,
  TEAM_SIZE_HARD_CEILING,
  TEAM_SIZE_RECOMMENDED,
} from "@/apps/agent/store/settings/useAgentSettingsStore";
import {
  AgwPill,
  AgwSelect,
  AgwSwitch,
  SettingsRow,
  SettingsSection,
  type SelectOption,
} from "./primitives";

// ── Stepper (team size) ──────────────────────────────────────────────────────

const Stepper: React.FC<{
  value: number;
  min: number;
  max: number;
  onChange: (next: number) => void;
  disabled?: boolean;
  format: (v: number) => string;
}> = ({ value, min, max, onChange, disabled, format }) => {
  const clamp = (v: number) => Math.max(min, Math.min(max, v));
  return (
    <div className="agw-agent-stepper" data-disabled={disabled || undefined}>
      <button
        type="button"
        className="agw-agent-stepper-btn"
        aria-label="Decrease team size"
        disabled={disabled || value <= min}
        onClick={() => onChange(clamp(value - 1))}
      >
        &#8722;
      </button>
      <span className="agw-agent-stepper-val">{format(value)}</span>
      <button
        type="button"
        className="agw-agent-stepper-btn"
        aria-label="Increase team size"
        disabled={disabled || value >= max}
        onClick={() => onChange(clamp(value + 1))}
      >
        +
      </button>
    </div>
  );
};

// ── Page ─────────────────────────────────────────────────────────────────────

export const TeamSettings: React.FC = () => {
  const teamEnabled = useAgentSettingsStore((s) => s.teamEnabled);
  const maxTeamSize = useAgentSettingsStore((s) => s.maxTeamSize);
  const setTeamEnabled = useAgentSettingsStore((s) => s.setTeamEnabled);
  const setMaxTeamSize = useAgentSettingsStore((s) => s.setMaxTeamSize);
  const teamMemberModel = useAgentSettingsStore((s) => s.teamMemberModel);
  const setTeamMemberModel = useAgentSettingsStore((s) => s.setTeamMemberModel);

  const providers = useAgentSettingsStore((s) => s.providers);
  const modelSlice = useAgentSettingsStore((s) => s.models);
  const getAvailableModels = useAgentSettingsStore((s) => s.getAvailableModels);

  const modelOptions = useMemo<SelectOption[]>(() => {
    const options: SelectOption[] = [
      { value: "", label: "Same as chat model", meta: "default" },
    ];
    for (const m of getAvailableModels()) {
      options.push({
        value: `${m.providerId}:${m.model}`,
        label: m.label,
        meta: m.providerName,
      });
    }
    return options;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providers, modelSlice, getAvailableModels]);

  return (
    <div className="agw-set-wide">
      {/* Agent Team */}
      <SettingsSection
        icon="users"
        title="Agent Team"
        description="Give a big task to the agent you're chatting with (the lead), and it assigns scoped peer workers that can coordinate with each other while they work in parallel. You keep talking to the lead; the team works underneath."
        badge={
          <AgwPill tone={teamEnabled ? "success" : "neutral"}>
            {teamEnabled ? "Enabled" : "Disabled"}
          </AgwPill>
        }
      >
        <SettingsRow
          label="Enable Agent Team"
          hint="When on, the lead can convene a team for a request instead of working solo."
        >
          <AgwSwitch
            checked={teamEnabled}
            onChange={setTeamEnabled}
            ariaLabel="Toggle Agent Team"
          />
        </SettingsRow>

        <SettingsRow
          label="Maximum workers"
          hint={`Recommended: ${TEAM_SIZE_RECOMMENDED}. The number of parallel workers the lead can spin up per task. The lead is separate and always present — it's not counted here.`}
        >
          <Stepper
            value={maxTeamSize}
            min={1}
            max={TEAM_SIZE_HARD_CEILING - 1}
            onChange={setMaxTeamSize}
            disabled={!teamEnabled}
            format={(v) => `${v} ${v === 1 ? "worker" : "workers"}`}
          />
        </SettingsRow>

        <SettingsRow
          label="Coordinator"
          hint="Whoever you're chatting with — the model in your composer's selector. It reads your task and decides to convene a team. There's nothing to pick here; switch it by switching your chat model."
        >
          <span style={{ fontSize: "var(--agw-fs-label)", color: "var(--agw-text-subtle)" }}>
            Your active chat model
          </span>
        </SettingsRow>

        <SettingsRow
          last
          label="Team model"
          hint="The model every worker runs on. Set this and the workers never use your chat provider. Defaults to your chat model when left blank."
        >
          <AgwSelect
            value={teamMemberModel}
            options={modelOptions}
            onChange={setTeamMemberModel}
            ariaLabel="Team model"
            disabled={!teamEnabled}
          />
        </SettingsRow>
      </SettingsSection>

      {/* Recent runs — placeholder until wired to team_run_status history. */}
      <SettingsSection
        icon="layers"
        title="Recent runs"
        description="Team runs for this project — their goal, phase, and outcome."
      >
        <SettingsRow last label="History" hint="Populates once the team has run in this project.">
          <span style={{ fontSize: "var(--agw-fs-label)", color: "var(--agw-text-subtle)" }}>
            No team runs yet.
          </span>
        </SettingsRow>
      </SettingsSection>
    </div>
  );
};