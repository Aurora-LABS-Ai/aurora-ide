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
import { AgentDragGhost } from "@/apps/agent/components/composer/AgentDragGhost";
import { AgentThemeProvider } from "@/apps/agent/components/theme/AgentThemeProvider";
import { AgentTitlebar } from "@/apps/agent/components/shell/AgentTitlebar";
import { AgentToaster } from "@/apps/agent/components/shell/AgentToaster";
import { AgentShell } from "@/apps/agent/components/shell/AgentShell";
import { IconRail } from "@/apps/agent/components/shell/IconRail";
import { ImagesPage } from "@/apps/agent/components/images/ImagesPage";
import { LibraryPage } from "@/apps/agent/components/library/LibraryPage";
import { PluginsPage } from "@/apps/agent/components/plugins/PluginsPage";
import { ProvidersPage } from "@/apps/agent/components/providers/ProvidersPage";
import { SettingsPage } from "@/apps/agent/settings/SettingsPage";
import { useAgentSettingsStore } from "@/apps/agent/store/settings/useAgentSettingsStore";
import { syncCursorModelsQuietly } from "@/apps/agent/services/providers/cursor-sync";
import { registerQuestionHandler } from "@/apps/agent/services/tools/question-bridge";
import { useAgentEditorOpen } from "@/apps/agent/hooks/useAgentEditorOpen";
import { useLocalProviderDetection } from "@/apps/agent/hooks/providers/useLocalProviderDetection";
import { useAgentPathDrag } from "@/apps/agent/hooks/drag/useAgentPathDrag";
import { useBackgroundProcessWatch } from "@/apps/agent/hooks/useBackgroundProcessWatch";
import { useAgentWindowBounds } from "@/apps/agent/hooks/window/useAgentWindowBounds";
import { useAuroraBridge } from "@/apps/agent/hooks/window/useAuroraBridge";
import { restoreThreadAfterReload, useReloadRestore } from "@/apps/agent/hooks/window/useReloadRestore";
import { useAgentChatStore } from "@/apps/agent/store/conversation/useAgentChatStore";
import { useAgentQuestionStore } from "@/apps/agent/store/tools/useAgentQuestionStore";
import { useAgentUiStore } from "@/apps/agent/store/ui/useAgentUiStore";
import { AgentCommandCenter } from "@/apps/agent/components/modals/AgentCommandCenter";
import { useAgentArtifactStore } from "@/apps/agent/store/artifacts/useAgentArtifactStore";

/** Read the project this window is scoped to from the launch URL (`?ws=`). */
function readProjectRootFromUrl(): string | null {
  if (typeof window === "undefined") return null;
  const ws = new URLSearchParams(window.location.search).get("ws");
  return ws && ws.length > 0 ? ws : null;
}

export const AgentWindow: React.FC = () => {
  const init = useAgentChatStore((s) => s.init);
  const currentThreadId = useAgentChatStore((s) => s.currentThreadId);
  const view = useAgentUiStore((s) => s.view);

  // Remember the OS window's size (and maximized state) across closes so the
  // next launch reopens at the size the user last set — never the default.
  useAgentWindowBounds();

  // Track the open chat so an in-window reload can land back in it.
  useReloadRestore();

  // Tell other processes this window is here and what it is doing, so an agent
  // connected over MCP knows whether it can send work — and what happens to it.
  useAuroraBridge();

  // Files open in this window's right rail, never in the IDE's editor.
  useAgentEditorOpen();

  // Background-probe for local AI servers (Ollama, LM Studio) and fill in their
  // provider rows. Agent-only: the editor carries no agent.
  useLocalProviderDetection();

  // Dragging a file out of the Files panel and onto a composer. One coordinator
  // per window owns the pointer listeners for every source and drop zone in it.
  useAgentPathDrag();

  // Background processes end whether or not anyone has the process panel open,
  // and a tool card in the transcript is one of the things that has to know.
  useBackgroundProcessWatch(currentThreadId);

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

  // Cursor's catalogue lives in its own table, so the models someone switched
  // on there have to be copied into the shared model list before the picker
  // can offer them. Done once per window rather than on demand: the picker is
  // synchronous, and a plan that changed while Aurora was closed would
  // otherwise show yesterday's models until Settings happened to be opened.
  //
  // Gated on the settings store having loaded. The mirror REPLACES this
  // provider's rows, so running it against a store that is still empty would
  // be overwritten moments later by the database read finishing.
  const settingsReady = useAgentSettingsStore((s) => s.isInitialized);
  useEffect(() => {
    if (!settingsReady) return;
    syncCursorModelsQuietly();
  }, [settingsReady]);

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
        {/* The icon rail is on every view; the view beside it is one of Home
            (the shell: chat list + conversation), a rail destination, or
            settings. A destination replaces the shell outright, so the chat
            list folds with it and comes back with Home. */}
        <div className="agw-window-body">
          <IconRail />
          {view === "settings" ? (
            <SettingsPage />
          ) : view === "images" ? (
            <ImagesPage />
          ) : view === "library" ? (
            <LibraryPage />
          ) : view === "plugins" ? (
            <PluginsPage />
          ) : view === "providers" ? (
            <ProvidersPage />
          ) : (
            <AgentShell />
          )}
        </div>
        <AgentCommandCenter />
        {/* Follows the cursor during a file drag; renders nothing otherwise. */}
        <AgentDragGhost />
        {/* "Prompt copied" and friends, from anywhere: `toast()`. */}
        <AgentToaster />
      </AgentThemeProvider>
    </MotionConfig>
  );
};
