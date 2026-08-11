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

import React, { useMemo } from "react";

import {
  useSettingsStore,
  COMPACTION_THRESHOLD_MIN,
  COMPACTION_THRESHOLD_MAX,
  COMPACTION_SUMMARY_BUDGET_MIN,
  COMPACTION_SUMMARY_BUDGET_MAX,
} from "@/kernel/store/useSettingsStore";
import { CodeIndexCard } from "./CodeIndexCard";
import {
  AgwPill,
  AgwSegmented,
  AgwSelect,
  AgwSwitch,
  SettingsBlock,
  SettingsRow,
  SettingsSection,
  type SegmentOption,
  type SelectOption,
} from "./primitives";

type Mode = "agent" | "plan";

const MODE_OPTIONS: SegmentOption<Mode>[] = [
  { value: "agent", label: "Agent" },
  { value: "plan", label: "Plan" },
];

const GLOBAL_INSTRUCTIONS_MAX = 4000;

export const AgentSettings: React.FC = () => {
  const browserTools = useSettingsStore((s) => s.browserTools);
  const setBrowserTools = useSettingsStore((s) => s.setBrowserTools);
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
  const compactionModel = useSettingsStore((s) => s.compactionModel);
  const setCompactionModel = useSettingsStore((s) => s.setCompactionModel);

  const providers = useSettingsStore((s) => s.providers);
  const modelSlice = useSettingsStore((s) => s.models);
  const getAvailableModels = useSettingsStore((s) => s.getAvailableModels);

  // Same shape as the Team page's picker: a leading "inherit" row, then every
  // configured model keyed by `providerId:modelKey`.
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
          label="Summary detail"
          hint="How much the agent may write when handing off to itself. It drafts a pass over the whole conversation first, then writes the note that survives — so a tight budget cuts the note short, and what it loses is the end: what you were doing right now and what comes next."
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

        <SettingsRow
          last
          label="Compaction model"
          hint="The model that writes the summary. Leaving this alone is usually cheapest: your chat model has already cached this conversation, so it re-reads it at roughly a tenth of the price, while another model pays full rate for every token. A different model only saves money if it costs less than your chat model's cached rate — and it needs a context window at least as large, since it has to read the whole history. Its summary is also all the agent will remember, so a weak one costs you more than it saves."
        >
          <AgwSelect
            value={compactionModel}
            options={modelOptions}
            onChange={setCompactionModel}
            ariaLabel="Compaction model"
          />
        </SettingsRow>
      </SettingsSection>

      <SettingsSection
        title="Browser control"
        icon="browser"
        description="The agent's embedded browser panel — open a running page, look at it, click through it, read its console."
      >
        <SettingsRow
          last
          alignTop
          label="Give the agent the browser toolset"
          searchTerms="browser tools toolset disable enable tokens schemas cost web preview devtools"
          hint="Sixteen tools, and their descriptions are sent on every single request — about 2,800 tokens whether or not the turn ever opens a page. Only Anthropic gets a caching marker from Aurora, so on every other provider you pay that in full, every time. Switch it off and the whole set is unregistered: the agent is not told a browser exists, and will not offer to check one. Leave it on if you build for the web."
        >
          <AgwSwitch
            checked={browserTools}
            onChange={setBrowserTools}
            ariaLabel="Give the agent the browser toolset"
          />
        </SettingsRow>
      </SettingsSection>

      <SettingsSection
        title="Code index"
        icon="workspace-tree"
        description="A structural map of this project — every definition, and what uses it. It is how the agent answers “where is this defined” and “what calls this” without searching text, and it is what the repository overview at the start of a conversation is built from."
      >
        <CodeIndexCard />
      </SettingsSection>
    </div>
  );
};
