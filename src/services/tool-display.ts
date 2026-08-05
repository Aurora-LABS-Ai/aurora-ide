import { getToolDisplayName } from "./mcp-tools";

const TOOL_DISPLAY_NAMES: Record<string, string> = {
  auroro_websearch: "Search the Web",
  editor_open_file: "Open File in Editor",
  // Current file/folder tools.
  file_read: "Read File",
  file_write: "Write File",
  file_edit: "Edit File",
  move_path: "Move or Rename",
  delete_path: "Delete",
  folder_create: "Create Folder",
  grep: "Search Codebase",
  // Deliberately contrasted with grep's "Search Codebase": one finds files by
  // NAME, the other by CONTENT, and a user scanning a transcript needs to tell
  // the two apart at a glance.
  glob: "Find Files",
  read_lints: "Read Diagnostics",
  // Legacy file/folder names — kept so historic threads render cleanly.
  file_create: "Create New File",
  file_delete: "Delete File",
  file_patch: "Apply File Patch",
  folder_move: "Move Folder",
  folder_delete: "Delete Folder",
  multi_file_read: "Read Multiple Files",
  multi_search_replace: "Apply Batch Edits",
  search_replace: "Apply Targeted Edit",
  shell_execute: "Run Command",
  shell_kill: "Stop Background Process",
  shell_list_processes: "List Running Processes",
  shell_spawn: "Start Background Process",
  // Two separate systems, and the labels must not blur them: "Task List" is the
  // agent's working checklist, "Plan" is the Plan-mode document in the Canvas.
  // Without these entries the fallback title-cased them into "Todo" and
  // "Plan Step Update", which read as internal names.
  todo: "Task List",
  // Only ever seen when the call was REJECTED — an accepted `chapter` renders as
  // a heading in the transcript, not a tool card. The label has to make sense in
  // that one context: "Chapter" alone would read as a heading that failed for no
  // stated reason, next to the error the runtime returned.
  chapter: "Name This Part",
  plan_write: "Write Plan",
  plan_read: "Read Plan",
  plan_step_update: "Plan Progress",
  workspace_tree: "Inspect Workspace",
  ask_question: "Ask the User",
  present_artifact: "Present on Canvas",
  read_artifact: "Read Canvas Source",
  // Browser tools — keep the names short and verb-led so the chat
  // card reads like a human action ("Click Element" instead of
  // "Browser Click"). The legacy auto-title-case produced "Browser
  // Eval", which is both jargon and an obvious foot-gun signal to the
  // user that something is wrong.
  browser_open: "Open Browser",
  browser_close: "Close Browser",
  browser_navigate: "Browse to URL",
  browser_click: "Click Element",
  browser_fill: "Type into Field",
  browser_scroll: "Scroll Page",
  browser_screenshot: "Screenshot Page",
  browser_get_console_logs: "Read Console Logs",
  browser_page_outline: "Map Page Elements",
  // Legacy tool names that are no longer registered with the agent —
  // kept here so historic chat threads with these in their JSONL log
  // still get a clean display label instead of a raw tool id.
  browser_eval: "Run JavaScript (legacy)",
  browser_get_dom: "Read Page HTML (legacy)",
  browser_get_url: "Read Page URL (legacy)",
  browser_inspect_element: "Inspect Element State",
  browser_list_windows: "List Browser Windows (legacy)",
  browser_wait_for: "Wait for Element (legacy)",
};

const formatFallbackToolName = (toolName: string): string =>
  toolName
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");

export const getProfessionalToolName = (toolName: string): string => {
  if (toolName.startsWith("mcp_")) {
    return getToolDisplayName(toolName);
  }

  return TOOL_DISPLAY_NAMES[toolName] || formatFallbackToolName(toolName);
};
