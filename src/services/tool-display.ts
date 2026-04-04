import { getToolDisplayName } from "./mcp-tools";

const TOOL_DISPLAY_NAMES: Record<string, string> = {
  aurora_search: "Search Codebase",
  auroro_websearch: "Search the Web",
  editor_open_file: "Open File in Editor",
  file_create: "Create New File",
  file_delete: "Delete File",
  file_patch: "Apply File Patch",
  file_read: "Read File",
  file_write: "Rewrite File",
  folder_create: "Create Folder",
  folder_delete: "Delete Folder",
  grep: "Search File Contents",
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
