import { getToolDisplayName } from "./mcp-tools";

const TOOL_DISPLAY_NAMES: Record<string, string> = {
  auroro_websearch: "Search the Web",
  editor_open_file: "Open File in Editor",
  file_create: "Create New File",
  file_delete: "Delete File",
  file_patch: "Apply File Patch",
  file_read: "Read File",
  file_write: "Rewrite File",
  folder_create: "Create Folder",
  folder_move: "Move Folder",
  folder_delete: "Delete Folder",
  grep: "Search Codebase",
  multi_file_read: "Read Multiple Files",
  multi_search_replace: "Apply Batch Edits",
  read_lints: "Read Diagnostics",
  search_replace: "Apply Targeted Edit",
  shell_execute: "Run Command",
  shell_kill: "Stop Background Process",
  shell_list_processes: "List Running Processes",
  shell_spawn: "Start Background Process",
  todo_write: "Update Task List",
  workspace_tree: "Inspect Workspace",
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
  // Legacy tool names that are no longer registered with the agent —
  // kept here so historic chat threads with these in their JSONL log
  // still get a clean display label instead of a raw tool id.
  browser_eval: "Run JavaScript (legacy)",
  browser_get_dom: "Read Page HTML (legacy)",
  browser_get_url: "Read Page URL (legacy)",
  browser_inspect_element: "Inspect Element (legacy)",
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
