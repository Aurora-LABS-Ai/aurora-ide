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
 *   4. Chat title maker — optional AI titling of new chats.
 *
 * The Agent Team lives on its own dedicated "Team" settings tab.
 */

import React, { useState } from "react";

import {
  useSettingsStore,
  COMPACTION_THRESHOLD_MIN,
  COMPACTION_THRESHOLD_MAX,
  COMPACTION_SUMMARY_BUDGET_MIN,
  COMPACTION_SUMMARY_BUDGET_MAX,
} from "../../store/useSettingsStore";
import { AgentIcon } from "../shared/AgentIcon";
import {
  AgwPill,
  AgwSegmented,
  AgwSwitch,
  AgwTextInput,
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

  const titleMakerEnabled = useSettingsStore((s) => s.titleMakerEnabled);
  const titleMakerBaseUrl = useSettingsStore((s) => s.titleMakerBaseUrl);
  const titleMakerApiKey = useSettingsStore((s) => s.titleMakerApiKey);
  const titleMakerModel = useSettingsStore((s) => s.titleMakerModel);
  const setTitleMaker = useSettingsStore((s) => s.setTitleMaker);
  const [showTitleKey, setShowTitleKey] = useState(false);

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

      {/* Chat title maker */}
      <SettingsSection
        icon="message"
        title="Chat title maker"
        description="Generate a short title for each new chat from your first message, using your own OpenAI-compatible endpoint. Off uses the title derived from your message. Only the first message of a new chat is titled; if the request fails, the derived title is kept."
        badge={
          <AgwPill tone={titleMakerEnabled ? "success" : "neutral"}>
            {titleMakerEnabled ? "Enabled" : "Disabled"}
          </AgwPill>
        }
      >
        <SettingsRow
          label="Enable title maker"
          hint="When on, the first message of every new chat is sent to the endpoint below to name the chat."
        >
          <AgwSwitch
            checked={titleMakerEnabled}
            onChange={(v) => setTitleMaker({ enabled: v })}
            ariaLabel="Toggle chat title maker"
          />
        </SettingsRow>

        <SettingsRow
          label="Base URL"
          hint="OpenAI-compatible endpoint root, e.g. https://api.openai.com/v1 or your local server."
        >
          <AgwTextInput
            value={titleMakerBaseUrl}
            placeholder="https://api.example.com/v1"
            disabled={!titleMakerEnabled}
            onChange={(e) => setTitleMaker({ baseUrl: e.target.value })}
            style={{ width: 280 }}
          />
        </SettingsRow>

        <SettingsRow
          label="Model ID"
          hint="The model to title with — exactly as the endpoint expects it (e.g. gpt-4o-mini)."
        >
          <AgwTextInput
            value={titleMakerModel}
            placeholder="gpt-4o-mini"
            disabled={!titleMakerEnabled}
            onChange={(e) => setTitleMaker({ model: e.target.value })}
            style={{ width: 280 }}
          />
        </SettingsRow>

        <SettingsRow
          last
          label="API key"
          hint="Optional — leave blank for a local server that needs no key. Stored locally with your settings."
        >
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <AgwTextInput
              type={showTitleKey ? "text" : "password"}
              value={titleMakerApiKey}
              placeholder="sk-…"
              disabled={!titleMakerEnabled}
              onChange={(e) => setTitleMaker({ apiKey: e.target.value })}
              style={{ width: 244 }}
            />
            <button
              type="button"
              className="agw-prov-icon-btn"
              title={showTitleKey ? "Hide" : "Show"}
              aria-label={showTitleKey ? "Hide API key" : "Show API key"}
              onClick={() => setShowTitleKey((v) => !v)}
            >
              <AgentIcon name={showTitleKey ? "inspect" : "browser"} size={14} />
            </button>
          </div>
        </SettingsRow>
      </SettingsSection>
    </div>
  );
};
