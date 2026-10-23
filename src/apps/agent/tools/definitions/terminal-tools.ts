/**
 * The agent's `terminal` tool — display and approval metadata only.
 *
 * The tool runs in Rust (`src-tauri/src/tools/shell_editor_todo/terminal.rs`)
 * and its schema is Rust's; `nativeRustOwned` keeps this copy out of the
 * model's roster. It replaced the window's two read-only tools,
 * `terminal_list` and `terminal_read`, which read xterm's buffer here: Rust
 * now owns every terminal and its screen, and the one tool also starts, types
 * into and stops the agent's own tabs.
 */
import type { ToolDefinition } from "@/apps/agent/tools/types";

export const terminalTool: ToolDefinition = {
  type: "function",
  nativeRustOwned: true,
  function: {
    name: "terminal",
    description:
      "Terminals in Aurora's Terminal panel. {} lists them; {command} starts one in a new tab; {id} reads it; {id, input} or {id, keys} types into one you started; {id, stop: true} stops it.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Start: the command to run in a new terminal." },
        name: { type: "string", description: "Start: the tab's title." },
        shell: { type: "string", description: "Start: which shell." },
        cwd: { type: "string", description: "Start: working directory." },
        id: { type: "string", description: "The terminal to read, type into or stop." },
        input: { type: "string", description: "Text to type; end with \\n for Enter." },
        keys: { type: "array", items: { type: "string" }, description: "Named keys to press." },
        stop: { type: "boolean", description: "true stops it." },
      },
      required: [],
    },
  },
};

export const terminalTools: ToolDefinition[] = [terminalTool];
