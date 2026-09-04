/**
 * Agent Window — attached slash (`/`) commands store (feature state).
 *
 * The composer's `/` picker (see `adapters/prompt-commands.ts`) drops directives
 * here — skills, project rules, and MCP servers — rendered as chips above the
 * input. The send pipeline reads them once at turn start (deriving explicit skill
 * keys / rule filenames / MCP ids), threads them into the prompt, then clears the
 * store. Mirrors how `useAgentSelectionStore` / `useAgentAttachmentStore` feed the
 * turn. Kept separate from the IDE so the two windows don't share state.
 *
 * Keyed by COMPOSER (see `composerKey`) for the same reason as
 * `useAgentAttachmentStore`: the window can show several composers at once, and
 * directives staged in one must not ride out with another one's message.
 */

import { create } from "zustand";
import type { PromptCommand } from "@/apps/agent/adapters/prompt-commands";

/** Stable empty array so a selector for an unstaged composer never re-renders. */
const NO_COMMANDS: PromptCommand[] = [];

interface AgentCommandState {
  /** Staged directives per composer key. */
  byComposer: Record<string, PromptCommand[]>;
  /** Add a command (deduped by key — picking the same one twice is a no-op). */
  add: (composer: string, command: PromptCommand) => void;
  remove: (composer: string, key: string) => void;
  clear: (composer: string) => void;
}

/** One composer's staged directives. Safe to call inside a zustand selector. */
export const composerCommands = (
  state: { byComposer: Record<string, PromptCommand[]> },
  composer: string,
): PromptCommand[] => state.byComposer[composer] ?? NO_COMMANDS;

export const useAgentCommandStore = create<AgentCommandState>((set) => ({
  byComposer: {},
  add: (composer, command) =>
    set((state) => {
      const list = state.byComposer[composer] ?? [];
      if (list.some((c) => c.key === command.key)) return state;
      return { byComposer: { ...state.byComposer, [composer]: [...list, command] } };
    }),
  remove: (composer, key) =>
    set((state) => ({
      byComposer: {
        ...state.byComposer,
        [composer]: (state.byComposer[composer] ?? []).filter((c) => c.key !== key),
      },
    })),
  clear: (composer) =>
    set((state) => {
      if (!state.byComposer[composer]?.length) return state;
      const byComposer = { ...state.byComposer };
      delete byComposer[composer];
      return { byComposer };
    }),
}));

/** Derived turn payload: the bits the send pipeline threads into the prompt. */
export interface CommandSelection {
  explicitSkillKeys: string[];
  ruleFilenames: string[];
  mcpServerNames: string[];
  /** `/image` was attached: the user wants a picture made of this message. */
  imageRequested: boolean;
}

export function buildCommandSelection(commands: PromptCommand[]): CommandSelection {
  const explicitSkillKeys: string[] = [];
  const ruleFilenames: string[] = [];
  const mcpServerNames: string[] = [];
  let imageRequested = false;

  for (const command of commands) {
    if (command.kind === "skill" && command.skillStorageKey) {
      explicitSkillKeys.push(command.skillStorageKey);
    } else if (command.kind === "rule" && command.ruleFilename) {
      ruleFilenames.push(command.ruleFilename);
    } else if (command.kind === "mcp") {
      mcpServerNames.push(command.title);
    } else if (command.kind === "image") {
      imageRequested = true;
    }
  }

  return { explicitSkillKeys, ruleFilenames, mcpServerNames, imageRequested };
}
