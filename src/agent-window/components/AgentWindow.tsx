/**
 * Agent Window — module root component (view).
 *
 * The standalone, conversation-first agent workspace. Mounts the isolated theme
 * provider (its own `--agw-*` tokens) around the 3-zone shell. Self-contained:
 * drop it anywhere with 100% height/width and it renders fully themed, with zero
 * dependency on the IDE's global theme.
 */

import React, { useEffect } from "react";
import { MotionConfig } from "framer-motion";
import { AgentThemeProvider } from "./AgentThemeProvider";
import { AgentTitlebar } from "./AgentTitlebar";
import { AgentShell } from "./AgentShell";
import { SettingsPage } from "../settings/SettingsPage";
import { registerQuestionHandler } from "../../services/question-bridge";
import { registerTeamViewOpener } from "../../services/team-view-bridge";
import { useAgentWindowBounds } from "../hooks/useAgentWindowBounds";
import { restoreThreadAfterReload, useReloadRestore } from "../hooks/useReloadRestore";
import { useTeamStore } from "../../store/useTeamStore";
import { useAgentChatStore } from "../store/useAgentChatStore";
import { useAgentQuestionStore } from "../store/useAgentQuestionStore";
import { useAgentUiStore } from "../store/useAgentUiStore";
import { AgentCommandCenter } from "./AgentCommandCenter";
import { useAgentArtifactStore } from "../store/useAgentArtifactStore";

/** Read the project this window is scoped to from the launch URL (`?ws=`). */
function readProjectRootFromUrl(): string | null {
  if (typeof window === "undefined") return null;
  const ws = new URLSearchParams(window.location.search).get("ws");
  return ws && ws.length > 0 ? ws : null;
}

export const AgentWindow: React.FC = () => {
  const init = useAgentChatStore((s) => s.init);
  const projectRoot = useAgentChatStore((s) => s.projectRoot);
  const currentThreadId = useAgentChatStore((s) => s.currentThreadId);
  const view = useAgentUiStore((s) => s.view);

  // Remember the OS window's size (and maximized state) across closes so the
  // next launch reopens at the size the user last set — never the default.
  useAgentWindowBounds();

  // Track the open chat so an in-window reload can land back in it.
  useReloadRestore();

  // Bind the window to its project + load that project's chats once. If this
  // mount is a RELOAD of the same window (Ctrl+R, or the native crash-recovery
  // auto-reload after a renderer crash), re-open the chat that was on screen —
  // a crash mid-run then recovers straight into the live transcript instead of
  // dumping the user on the project home.
  useEffect(() => {
    void (async () => {
      await init(readProjectRootFromUrl());
      restoreThreadAfterReload();
    })();
  }, [init]);

  // The team lives INSIDE this window now (a center-column takeover), not a
  // separate OS window. Let the Lead's `team_show` / `team_dispatch` tools
  // reveal it via the bridge instead of spawning a window.
  useEffect(
    () => registerTeamViewOpener(() => useAgentUiStore.getState().openTeam()),
    [],
  );

  // Keep the team brain snapshot warm for whatever project this window is scoped
  // to, so the rail's Team entry and the Team screen are live the moment they're
  // shown (and re-scope with the project).
  useEffect(() => {
    if (!projectRoot) return;
    void useTeamStore.getState().start(projectRoot);
    return () => useTeamStore.getState().stop();
  }, [projectRoot]);

  // Route the agent's `ask_question` tool to this window's question store, so a
  // tool call rises the inline prompt above the composer and blocks the turn
  // until the user answers. Cleared on unmount so a closed window stops claiming
  // requests.
  useEffect(
    () => registerQuestionHandler((request) => useAgentQuestionStore.getState().ask(request)),
    [],
  );

  useEffect(() => {
    if (!currentThreadId) return;
    void useAgentArtifactStore.getState().loadThread(currentThreadId).catch(() => undefined);
  }, [currentThreadId]);

  // The expand/collapse glide (tool cards, reasoning) must feel exactly like the
  // IDE chat, which always animates. `reducedMotion="user"` was overriding that:
  // with the OS "reduce motion" setting on, framer-motion skipped straight to the
  // end height, making every dropdown snap open instantly. Match the IDE — animate
  // unconditionally (`"never"` = never auto-reduce).
  return (
    <MotionConfig reducedMotion="never">
      <AgentThemeProvider>
        {/* Frameless window — the themed titlebar replaces the native caption. */}
        <AgentTitlebar />
        {view === "settings" ? <SettingsPage /> : <AgentShell />}
        <AgentCommandCenter />
      </AgentThemeProvider>
    </MotionConfig>
  );
};
