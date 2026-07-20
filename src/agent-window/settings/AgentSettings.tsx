/**
 * Agent Window — Settings · Agent (view).
 *
 * The agent's behavior surface, agw-native. One page for everything that
 * defines how the agent operates, all reading/writing the SHARED
 * `useSettingsStore` so the IDE and agent window stay in lockstep:
 *
 *   1. Global instructions — a single, workspace-agnostic rule set injected into
 *      the agent's system prompt for EVERY workspace (Cursor-style "global rule").
 *   2. Execution mode — Agent (full toolset) vs Plan (read-only).
 *   3. Context compaction — when/how long history is summarized.
 *
 * The Agent Team lives on its own dedicated "Team" settings tab. Chat titling
 * is a window preference, not agent behavior — it lives on the Preferences page
 * next to Prompt refine (they can share the same local model).
 */

import React from "react";

import {
  useSettingsStore,
  COMPACTION_THRESHOLD_MIN,
  COMPACTION_THRESHOLD_MAX,
  COMPACTION_SUMMARY_BUDGET_MIN,
  COMPACTION_SUMMARY_BUDGET_MAX,
} from "../../store/useSettingsStore";
import {
  AgwPill,
  AgwSegmented,
  AgwSwitch,
  SettingsBlock,
  SettingsRow,
  SettingsSection,
  type SegmentOption,
} from "./primitives";

type Mode = "agent" | "plan";

const MODE_OPTIONS: SegmentOption<Mode>[] = [
  { value: "agent", label: "Agent" },
  { value: "plan", label: "Plan" },
];

const GLOBAL_INSTRUCTIONS_MAX = 4000;

export const AgentSettings: React.FC = () => {
  const executionMode = useSettingsStore((s) => s.agentExecutionMode);
  const setExecutionMode = useSettingsStore((s) => s.setAgentExecutionMode);

  const globalInstructions = useSettingsStore((s) => s.globalInstructions);
  const setGlobalInstructions = useSettingsStore((s) => s.setGlobalInstructions);

  const allowOutsideWorkspace = useSettingsStore((s) => s.allowOutsideWorkspace);
  const setAllowOutsideWorkspace = useSettingsStore((s) => s.setAllowOutsideWorkspace);

  const compactionThresholdPct = useSettingsStore((s) => s.compactionThresholdPct);
  const setCompactionThresholdPct = useSettingsStore((s) => s.setCompactionThresholdPct);
  const compactionSummaryBudget = useSettingsStore((s) => s.compactionSummaryBudget);
  const setCompactionSummaryBudget = useSettingsStore((s) => s.setCompactionSummaryBudget);

  const mode: Mode = executionMode === "plan" ? "plan" : "agent";
  const remaining = GLOBAL_INSTRUCTIONS_MAX - globalInstructions.length;

  return (
    <div className="agw-set-wide">
      {/* Global instructions */}
      <SettingsSection
        icon="message"
        title="Global instructions"
        description="Standing rules for the agent, applied to every workspace before any work — like one global rule you set once. Used by both this window and the IDE agent."
      >
        <SettingsBlock last>
          <textarea
            className="agw-set-textarea"
            value={globalInstructions}
            maxLength={GLOBAL_INSTRUCTIONS_MAX}
            onChange={(e) => setGlobalInstructions(e.target.value)}
            placeholder={
              "e.g. Always respond in concise, senior-engineer tone.\nPrefer TypeScript. Never add comments that just restate the code.\nAsk before large refactors."
            }
            spellCheck={false}
            rows={6}
          />
          <div className="agw-agent-ginfo">
            <span>Applies across all workspaces — high priority, but your message each turn still wins.</span>
            <span className="agw-agent-gcount" data-low={remaining < 200 || undefined}>
              {globalInstructions.length} / {GLOBAL_INSTRUCTIONS_MAX}
            </span>
          </div>
        </SettingsBlock>
      </SettingsSection>

      {/* Execution mode */}
      <SettingsSection
        icon="sliders"
        title="Execution mode"
        description="How the agent acts on your requests. Reasoning, temperature, and context window are model settings — set them on the model itself, under Providers."
      >
        <SettingsRow
          label="Mode"
          hint="Agent runs the full toolset. Plan is read-only — it explores and proposes, but won't modify files or run risky commands."
        >
          <AgwSegmented
            ariaLabel="Execution mode"
            value={mode}
            options={MODE_OPTIONS}
            onChange={setExecutionMode}
          />
        </SettingsRow>

        <SettingsRow
          last
          label="Read outside workspace"
          hint="Off, the agent can only read files inside the open project. On, it can also read files you point it to elsewhere on your computer (by absolute path). Writing and creating files always stays inside the workspace."
        >
          <AgwSwitch
            checked={allowOutsideWorkspace}
            onChange={setAllowOutsideWorkspace}
            ariaLabel="Allow reading files outside the workspace"
          />
        </SettingsRow>
      </SettingsSection>

      {/* Context compaction */}
      <SettingsSection
        icon="archive"
        title="Context compaction"
        description="When a chat gets long, Aurora summarizes the older history into a compact note so the model keeps room to work — without losing the thread. Your messages stay fully visible; only what the model re-reads shrinks."
      >
        <SettingsRow
          label="Compact at"
          hint="How full the context window gets before Aurora compacts. Lower compacts sooner and more often; higher waits longer."
        >
          <div className="agw-agent-range">
            <input
              type="range"
              className="agw-set-range"
              min={COMPACTION_THRESHOLD_MIN}
              max={COMPACTION_THRESHOLD_MAX}
              step={5}
              value={compactionThresholdPct}
              onChange={(e) => setCompactionThresholdPct(Number(e.target.value))}
              aria-label="Compaction threshold"
            />
            <AgwPill tone="neutral">{compactionThresholdPct}%</AgwPill>
          </div>
        </SettingsRow>

        <SettingsRow
          last
          label="Summary detail"
          hint="The token budget for each summary. Larger keeps more detail across the compaction; smaller is faster and leaner."
        >
          <div className="agw-agent-range">
            <input
              type="range"
              className="agw-set-range"
              min={COMPACTION_SUMMARY_BUDGET_MIN}
              max={COMPACTION_SUMMARY_BUDGET_MAX}
              step={1000}
              value={compactionSummaryBudget}
              onChange={(e) => setCompactionSummaryBudget(Number(e.target.value))}
              aria-label="Compaction summary budget"
            />
            <AgwPill tone="neutral">{Math.round(compactionSummaryBudget / 1000)}k tokens</AgwPill>
          </div>
        </SettingsRow>
      </SettingsSection>

    </div>
  );
};
