/**
 * Agent Window — Settings · Agent (view).
 *
 * The agent's behavior surface, agw-native. One page for everything that
 * defines how the agent operates, all reading/writing the SHARED
 * `useAgentSettingsStore` so the IDE and agent window stay in lockstep:
 *
 *   1. Global instructions — a single, workspace-agnostic rule set injected into
 *      the agent's system prompt for EVERY workspace (Cursor-style "global rule").
 *   2. Execution mode — Agent (full toolset) vs Plan (read-only).
 *   3. Context compaction — when/how long history is summarized.
 *
 * Chat titling is a window preference, not agent behavior — it lives on the Preferences page
 * next to Prompt refine (they can share the same local model).
 */

import React, { useEffect, useRef, useState } from "react";

import {
  useAgentSettingsStore,
  COMPACTION_THRESHOLD_MIN,
  COMPACTION_THRESHOLD_MAX,
  COMPACTION_SUMMARY_BUDGET_MIN,
  COMPACTION_SUMMARY_BUDGET_MAX,
  GLOBAL_INSTRUCTION_PROFILE_LIMIT,
  GLOBAL_INSTRUCTION_NAME_MAX,
} from "@/apps/agent/store/settings/useAgentSettingsStore";
import { AgentIcon } from "../shared/AgentIcon";
import { AgentBridgeCard } from "./AgentBridgeCard";
import {
  AgwPill,
  AgwSegmented,
  AgwSelect,
  AgwSwitch,
  SettingsBlock,
  SettingsRow,
  SettingsSection,
  type SegmentOption,
} from "./primitives";
import { SAME_AS_CHAT, useModelOptions } from "./useModelOptions";

type Mode = "agent" | "plan";

const MODE_OPTIONS: SegmentOption<Mode>[] = [
  { value: "agent", label: "Agent" },
  { value: "plan", label: "Plan" },
];

const GLOBAL_INSTRUCTIONS_MAX = 4000;

export const AgentGeneralSettings: React.FC = () => {
  const browserTools = useAgentSettingsStore((s) => s.browserTools);
  const mcpBridgeEnabled = useAgentSettingsStore((s) => s.mcpBridgeEnabled);
  const setMcpBridgeEnabled = useAgentSettingsStore((s) => s.setMcpBridgeEnabled);
  const setBrowserTools = useAgentSettingsStore((s) => s.setBrowserTools);
  const executionMode = useAgentSettingsStore((s) => s.agentExecutionMode);
  const setExecutionMode = useAgentSettingsStore((s) => s.setAgentExecutionMode);

  const giProfiles = useAgentSettingsStore((s) => s.globalInstructionProfiles);
  const giActiveId = useAgentSettingsStore((s) => s.activeGlobalInstructionProfileId);
  const addGiProfile = useAgentSettingsStore((s) => s.addGlobalInstructionProfile);
  const renameGiProfile = useAgentSettingsStore((s) => s.renameGlobalInstructionProfile);
  const setGiText = useAgentSettingsStore((s) => s.setGlobalInstructionProfileText);
  const setGiActive = useAgentSettingsStore((s) => s.setActiveGlobalInstructionProfile);
  const removeGiProfile = useAgentSettingsStore((s) => s.removeGlobalInstructionProfile);

  // Which set the editor is SHOWING — a view choice, not the persisted "which
  // set is sent" choice. Starts on the live set so opening the page shows what
  // the agent is actually using.
  const [giSelectedId, setGiSelectedId] = useState<string>(
    () => giActiveId || giProfiles[0]?.id || "",
  );
  const [giRenamingId, setGiRenamingId] = useState<string | null>(null);
  const [giNameDraft, setGiNameDraft] = useState("");
  const [giConfirmDelete, setGiConfirmDelete] = useState(false);
  const giRenameRef = useRef<HTMLInputElement>(null);

  const giSelected =
    giProfiles.find((p) => p.id === giSelectedId) ?? giProfiles[0];

  useEffect(() => {
    if (giRenamingId) giRenameRef.current?.select();
  }, [giRenamingId]);

  const startGiRename = (id: string, currentName: string) => {
    setGiRenamingId(id);
    setGiNameDraft(currentName);
  };
  const commitGiRename = () => {
    if (giRenamingId) renameGiProfile(giRenamingId, giNameDraft);
    setGiRenamingId(null);
  };
  const handleGiAdd = () => {
    const id = addGiProfile();
    if (!id) return;
    setGiSelectedId(id);
    // A fresh set is named "Persona N" — put the caret straight on it so the
    // user's first act is naming their persona, not hunting for Rename.
    const created = useAgentSettingsStore
      .getState()
      .globalInstructionProfiles.find((p) => p.id === id);
    startGiRename(id, created?.name ?? "");
  };
  const handleGiDelete = () => {
    if (!giSelected) return;
    if (!giConfirmDelete) {
      setGiConfirmDelete(true);
      return;
    }
    const fallback = giProfiles.find((p) => p.id !== giSelected.id);
    removeGiProfile(giSelected.id);
    setGiConfirmDelete(false);
    if (fallback) setGiSelectedId(fallback.id);
  };
  const handleGiTabKeys = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    const index = giProfiles.findIndex((p) => p.id === giSelected?.id);
    if (index < 0) return;
    const next =
      giProfiles[
        (index + (e.key === "ArrowRight" ? 1 : giProfiles.length - 1)) %
          giProfiles.length
      ];
    setGiSelectedId(next.id);
    e.preventDefault();
  };

  const compactionThresholdPct = useAgentSettingsStore((s) => s.compactionThresholdPct);
  const setCompactionThresholdPct = useAgentSettingsStore((s) => s.setCompactionThresholdPct);
  const compactionSummaryBudget = useAgentSettingsStore((s) => s.compactionSummaryBudget);
  const setCompactionSummaryBudget = useAgentSettingsStore((s) => s.setCompactionSummaryBudget);
  const compactionModel = useAgentSettingsStore((s) => s.compactionModel);
  const setCompactionModel = useAgentSettingsStore((s) => s.setCompactionModel);

  const modelOptions = useModelOptions(SAME_AS_CHAT);

  const mode: Mode = executionMode === "plan" ? "plan" : "agent";
  const giText = giSelected?.text ?? "";
  const giRemaining = GLOBAL_INSTRUCTIONS_MAX - giText.length;
  const giIsActive = !!giSelected && giSelected.id === giActiveId;

  return (
    <div className="agw-set-wide">
      {/* Global instructions */}
      <SettingsSection
        icon="message"
        title="Global instructions"
        description="Standing rules for Aurora Build and the IDE agent, applied across Build workspaces. Keep up to three named sets and activate one at a time. Aurora Chat does not receive these instructions."
      >
        <SettingsBlock last searchTerms="global instructions persona instruction set active rules">
          <div className="agw-gi-head">
            <div
              className="agw-gi-tabs"
              role="tablist"
              aria-label="Instruction sets"
              onKeyDown={handleGiTabKeys}
            >
              {giProfiles.map((profile) =>
                giRenamingId === profile.id ? (
                  <input
                    key={profile.id}
                    ref={giRenameRef}
                    className="agw-gi-tab-input"
                    value={giNameDraft}
                    maxLength={GLOBAL_INSTRUCTION_NAME_MAX}
                    onChange={(e) => setGiNameDraft(e.target.value)}
                    onBlur={commitGiRename}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commitGiRename();
                      if (e.key === "Escape") setGiRenamingId(null);
                    }}
                    aria-label="Set name"
                    spellCheck={false}
                  />
                ) : (
                  <button
                    key={profile.id}
                    type="button"
                    role="tab"
                    aria-selected={profile.id === giSelected?.id}
                    className="agw-gi-tab"
                    data-selected={profile.id === giSelected?.id || undefined}
                    onClick={() => {
                      setGiSelectedId(profile.id);
                      setGiConfirmDelete(false);
                    }}
                    onDoubleClick={() => startGiRename(profile.id, profile.name)}
                    title={
                      profile.id === giActiveId
                        ? `${profile.name} — sent with every Build turn`
                        : profile.name
                    }
                  >
                    {profile.id === giActiveId && (
                      <span className="agw-gi-tab-dot" aria-hidden />
                    )}
                    <span className="agw-gi-tab-name">{profile.name}</span>
                  </button>
                ),
              )}
            </div>
            {giProfiles.length < GLOBAL_INSTRUCTION_PROFILE_LIMIT && (
              <button
                type="button"
                className="agw-gi-add"
                onClick={handleGiAdd}
                aria-label="New instruction set"
                title={`New instruction set (up to ${GLOBAL_INSTRUCTION_PROFILE_LIMIT})`}
              >
                <AgentIcon name="plus" size={13} />
              </button>
            )}
          </div>

          {giSelected && (
            <>
              <textarea
                className="agw-set-textarea"
                value={giText}
                maxLength={GLOBAL_INSTRUCTIONS_MAX}
                onChange={(e) => setGiText(giSelected.id, e.target.value)}
                placeholder={
                  "e.g. Always respond in concise, senior-engineer tone.\nPrefer TypeScript. Never add comments that just restate the code.\nAsk before large refactors."
                }
                spellCheck={false}
                rows={6}
                aria-label={`Instructions for ${giSelected.name}`}
              />
              <div className="agw-gi-foot">
                <div className="agw-gi-activate">
                  <AgwSwitch
                    checked={giIsActive}
                    onChange={(on) => setGiActive(on ? giSelected.id : null)}
                    ariaLabel={`Use "${giSelected.name}" in every Build turn`}
                  />
                  <span className="agw-gi-state" data-on={giIsActive || undefined}>
                    {giIsActive
                      ? "Sent with every Build turn"
                      : "Not sent — switch on to use this set"}
                  </span>
                </div>
                <div className="agw-gi-actions">
                  <button
                    type="button"
                    className="agw-gi-actbtn"
                    onClick={() => startGiRename(giSelected.id, giSelected.name)}
                  >
                    Rename
                  </button>
                  {giProfiles.length > 1 && (
                    <button
                      type="button"
                      className="agw-gi-actbtn"
                      data-danger
                      data-confirm={giConfirmDelete || undefined}
                      onClick={handleGiDelete}
                      onMouseLeave={() => setGiConfirmDelete(false)}
                    >
                      {giConfirmDelete ? "Click again to delete" : "Delete"}
                    </button>
                  )}
                  <span
                    className="agw-agent-gcount"
                    data-low={giRemaining < 200 || undefined}
                  >
                    {giText.length} / {GLOBAL_INSTRUCTIONS_MAX}
                  </span>
                </div>
              </div>
            </>
          )}
        </SettingsBlock>
      </SettingsSection>

      {/* Execution mode */}
      <SettingsSection
        icon="sliders"
        title="Execution mode"
        description="How the agent acts on your requests. Reasoning, temperature, and context window belong to the model — open a model under Providers to set them."
      >
        {/* File access moved to Settings → Tools: it decides what the file
            tools may touch, which is the same question that page already
            answers for every other tool. */}
        <SettingsRow
          last
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
          hint="Let the agent open pages, inspect them, and interact with the embedded browser. It finds the tools it needs on demand. Switch this off to remove browser access from future turns."
        >
          <AgwSwitch
            checked={browserTools}
            onChange={setBrowserTools}
            ariaLabel="Give the agent the browser toolset"
          />
        </SettingsRow>
      </SettingsSection>

      <SettingsSection
        title="Tool loading"
        icon="layers"
        description="Core tools are always ready. Optional tool details are fetched when the agent needs them."
      >
        <SettingsRow
          last
          alignTop
          label="Optional tools load on demand"
          searchTerms="tool loading optional defer deferred tools on demand load lazy mcp browser tokens cost roster tool_search search"
          hint="Files, search, shell, tasks, and skills stay directly available. The agent finds tools for connected apps and browser control as needed. Finding a tool adds one discovery step; the agent can reuse its details while they remain in the conversation."
        >
          <span>Always on</span>
        </SettingsRow>
      </SettingsSection>

      <SettingsSection
        title="Other agents"
        icon="plug"
        description="Aurora connecting the other way round. You already connect Aurora to other apps' tools; this is another agent connecting to Aurora's."
      >
        <SettingsRow
          alignTop
          last={!mcpBridgeEnabled}
          label="Let other agents send work to Aurora"
          searchTerms="mcp server expose share bridge outside external claude code connect drive headless remote api integrate incoming"
          hint="Off, nothing outside Aurora can reach it. On, an agent you have connected can start conversations here, send messages into ones already going, and stop them — real turns with the full toolset, editing files in whatever project this window has open. It works only while this window is open, and only you can switch it on."
        >
          <AgwSwitch
            checked={mcpBridgeEnabled}
            onChange={setMcpBridgeEnabled}
            ariaLabel="Let other agents send work to Aurora"
          />
        </SettingsRow>

        {mcpBridgeEnabled && (
          <SettingsBlock last searchTerms="mcp config json snippet command copy connect aurora mcp server path">
            <AgentBridgeCard />
          </SettingsBlock>
        )}
      </SettingsSection>
    </div>
  );
};
