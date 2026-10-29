/**
 * The window's side of the agent's `terminal` tool.
 *
 * Rust owns the terminals; this hook only reacts to two announcements:
 *
 * - `terminal-opened` — the agent started a terminal. It gets a tab in the
 *   Terminal panel, which opens so the person can watch it.
 * - `terminal-exited` — one of the agent's terminals ended by itself, or the
 *   person closed its tab. The tab says so, and if that conversation is
 *   mid-turn the agent is told (queued into the turn, like a background
 *   process ending), with who ended it. An idle conversation is not woken: a
 *   later read of that id answers "closed by the user" from Rust.
 *
 * Mounted once, from `AgentWindow`, for the life of the window.
 */

import { useEffect } from "react";

import { auroraListen } from "@/kernel/lib/ipc/runtime";
import type { ShellProfile } from "@/apps/agent/adapters/shell-config";
import { useAgentChatStore } from "@/apps/agent/store/conversation/useAgentChatStore";
import { useAgentTerminalStore } from "@/apps/agent/store/ui/useAgentTerminalStore";
import { useAgentWorkspaceStore } from "@/apps/agent/store/workspace/useAgentWorkspaceStore";

interface TerminalOpened {
  id: number;
  title: string;
  shell: string;
  cwd?: string | null;
  ownerThread?: string | null;
  command?: string | null;
}

export interface TerminalExited {
  id: number;
  title: string;
  exitCode: number;
  ownerThread: string;
  /** `user` when the person closed the tab; absent when it ended by itself.
   * The agent's own stop sends no notice at all. */
  endedBy?: "user";
}

/**
 * The row shown in the conversation and the note the agent reads.
 *
 * Closing a tab ends the shell with a non-zero code, so before `endedBy`
 * existed the person closing a terminal they no longer needed reached the
 * agent as "Failed … · exit 1" plus an invitation to read output that was
 * already gone. The agent then guessed, re-read, or restarted it.
 */
export function terminalExitNotice(exited: TerminalExited): { summary: string; detail: string } {
  if (exited.endedBy === "user") {
    return {
      summary: `Closed ${exited.title} · by you`,
      detail:
        `The user closed your terminal "${exited.title}" (id ${exited.id}) from the Terminal ` +
        `panel. This was deliberate, not a crash: exit code ${exited.exitCode} comes from the ` +
        `close, and the terminal's output closed with it, so there is nothing to read. Do not ` +
        `start it again unless the user asks; carry on without it.`,
    };
  }
  const verb = exited.exitCode === 0 ? "Finished" : "Failed";
  return {
    summary: `${verb} ${exited.title} · exit ${exited.exitCode}`,
    detail:
      `Your terminal "${exited.title}" (id ${exited.id}) has exited with code ` +
      `${exited.exitCode}. Read what it printed with terminal {"id": "${exited.id}"}.`,
  };
}

const SHELLS: ShellProfile[] = ["pwsh", "powershell", "bash", "zsh", "sh", "cmd"];

function onOpened(opened: TerminalOpened): void {
  const profile = (SHELLS as string[]).includes(opened.shell)
    ? (opened.shell as ShellProfile)
    : "pwsh";
  useAgentTerminalStore.getState().adoptAgentSession({
    ptyId: opened.id,
    title: opened.title,
    profile,
    cwd: opened.cwd ?? undefined,
  });
  useAgentWorkspaceStore.getState().openTab("terminal");
}

function onExited(exited: TerminalExited): void {
  useAgentTerminalStore.getState().setPtyExited(exited.id);
  const chat = useAgentChatStore.getState();
  if (!chat.liveTurns[exited.ownerThread]) return;
  const { summary, detail } = terminalExitNotice(exited);
  void chat
    .enqueueMessage(exited.ownerThread, summary, { origin: "process", modelText: detail })
    .catch((error: unknown) => {
      // The tab already shows the ending; a failed note costs the agent a
      // notification, not the record.
      console.error("[agent-terminal] could not tell the turn the terminal ended:", error);
    });
}

export const useAgentTerminalWatch = (): void => {
  useEffect(() => {
    let disposed = false;
    const unlisten: Array<() => void> = [];
    const listen = <T,>(event: string, handle: (payload: T) => void) => {
      void auroraListen<T>(event, (message) => {
        if (!disposed && message?.payload) handle(message.payload);
      })
        .then((dispose) => {
          if (disposed) dispose();
          else unlisten.push(dispose);
        })
        .catch((error: unknown) => {
          console.error(`[agent-terminal] could not listen for ${event}:`, error);
        });
    };
    listen<TerminalOpened>("terminal-opened", onOpened);
    listen<TerminalExited>("terminal-exited", onExited);
    return () => {
      disposed = true;
      unlisten.forEach((dispose) => dispose());
    };
  }, []);
};
