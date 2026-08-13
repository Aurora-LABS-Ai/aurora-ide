/**
 * The user's own terminals, inside Aurora.
 *
 * These read the interactive shells the USER has open in Aurora's right rail —
 * what they typed and what it printed. That is a different thing from
 * `shell_execute`, which runs a command of the agent's own in a fresh
 * non-interactive shell and sees only its own output.
 *
 * Both tools are read-only. There is deliberately no write tool: typing into
 * someone's live shell is a different trust level, and the agent already has
 * `shell_execute` for running its own commands.
 */
import type { ToolDefinition } from "@/apps/agent/tools/types";

export const terminalListTool: ToolDefinition = {
  type: "function",
  function: {
    name: "terminal_list",
    description: `List the terminals the user currently has open INSIDE Aurora (the Terminal tab of the right rail).

These are the user's own interactive shells — the commands they ran by hand. They are not your \`shell_execute\` runs and do not share history with them.

Returns one entry per open terminal: \`id\`, \`title\` (what the user sees on the tab, e.g. "pwsh 1"), \`shell\` (pwsh / powershell / bash / zsh / cmd), \`cwd\`, \`running\` (false once its shell has exited), and \`lines\` of output held.

Call this when:
- The user refers to something they ran ("the build failed", "see the error", "it's still going") without pasting it. Read it instead of asking them to copy it.
- You need to know whether a long-running process they started is still alive.
- Before \`terminal_read\`, to find the right \`id\`.

Takes no arguments. Returns an empty list when no terminal is open.`,
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
  },
};

export const terminalReadTool: ToolDefinition = {
  type: "function",
  function: {
    name: "terminal_read",
    description: `Read the output of one terminal the user has open inside Aurora. Get \`id\` from \`terminal_list\`.

This is the user's own interactive shell in Aurora's right rail: their prompt, their commands, their output. Read it directly rather than asking the user to paste it.

\`scope\`:
- \`"last_command"\` (default) — output since the user last pressed Enter. This is what you want when they say something failed: it is that command's output and nothing else.
- \`"all"\` — the whole scrollback, up to 10,000 lines.

The result carries the first \`head_lines\` and the last \`tail_lines\` of the range, because both ends matter and the middle usually does not: a compiler prints the real error near the top and "could not compile" at the bottom; a test runner names the failing test first and the totals last. Anything dropped is stated inline as \`… N lines hidden …\` — never treat the two sides of that marker as consecutive output.

Notes:
- The text is already plain: terminal colour codes are resolved before you see it.
- A terminal whose shell has exited can still be read; \`running\` tells you which it is.
- Re-read the same id later to see what a still-running process has printed since.`,
    parameters: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "Terminal id from `terminal_list`.",
        },
        scope: {
          type: "string",
          enum: ["last_command", "all"],
          description:
            "`last_command` (default) reads only the most recent command's output; `all` reads the full scrollback.",
        },
        head_lines: {
          type: "number",
          description: "Lines to keep from the start of the range. Default 40.",
        },
        tail_lines: {
          type: "number",
          description: "Lines to keep from the end of the range. Default 40.",
        },
      },
      required: ["id"],

    },
  },
};

export const terminalTools: ToolDefinition[] = [terminalListTool, terminalReadTool];
