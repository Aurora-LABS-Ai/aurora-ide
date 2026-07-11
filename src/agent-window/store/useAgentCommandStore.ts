/**
 * Agent Window — attached slash (`/`) commands store (feature state).
 *
 * The composer's `/` picker (see `adapters/prompt-commands.ts`) drops directives
 * here — skills, project rules, and MCP servers — rendered as chips above the
 * input. The send pipeline reads them once at turn start (deriving explicit skill
 * keys / rule filenames / MCP ids), threads them into the prompt, then clears the
 * store. Mirrors how `useAgentSelectionStore` / `useAgentAttachmentStore` feed the
 * turn. Kept separate from the IDE so the two windows don't share state.
 */

import { create } from "zustand";
import type { PromptCommand } from "../adapters/prompt-commands";

interface AgentCommandState {
  commands: PromptCommand[];
  /** Add a command (deduped by key — picking the same one twice is a no-op). */
  add: (command: PromptCommand) => void;
  remove: (key: string) => void;
  clear: () => void;
}

export const useAgentCommandStore = create<AgentCommandState>((set) => ({
  commands: [],
  add: (command) =>
    set((state) =>
      state.commands.some((c) => c.key === command.key)
        ? {}
        : { commands: [...state.commands, command] },
    ),
  remove: (key) =>
    set((state) => ({ commands: state.commands.filter((c) => c.key !== key) })),
  clear: () => set({ commands: [] }),
}));

/** Derived turn payload: the bits the send pipeline threads into the prompt. */
export interface CommandSelection {
  explicitSkillKeys: string[];
  ruleFilenames: string[];
  mcpServerNames: string[];
}

export function buildCommandSelection(commands: PromptCommand[]): CommandSelection {
  const explicitSkillKeys: string[] = [];
  const ruleFilenames: string[] = [];
  const mcpServerNames: string[] = [];

  for (const command of commands) {
    if (command.kind === "skill" && command.skillStorageKey) {
      explicitSkillKeys.push(command.skillStorageKey);
    } else if (command.kind === "rule" && command.ruleFilename) {
      ruleFilenames.push(command.ruleFilename);
    } else if (command.kind === "mcp") {
      mcpServerNames.push(command.title);
    }
  }

  return { explicitSkillKeys, ruleFilenames, mcpServerNames };
}
