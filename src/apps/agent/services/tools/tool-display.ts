import { getToolDisplayName } from "@/apps/agent/services/tools/mcp-tools";

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
  // The user's own terminals in the right rail — named for what the reader
  // sees happening, never for the tool. "Terminal Read" would be the internal
  // name wearing title case.
  terminal_list: "Open Terminals",
  terminal_read: "Read Terminal",
  // The deferred-roster fetch (Settings → Tool loading). Named for what the
  // reader sees happening — the agent pulling in tools it needs — not the
  // internal id, which the fallback would title-case into "Tool Search".
  tool_search: "Find Tools",
  call_tool: "Run Tool",
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
  // Neutral until the operation is known; model discovery makes no image.
  generate_image: "Image Tools",
  generate_video: "Video Tools",
  recall: "Search Past Chats",
  remember: "Remember",
  canvas_guidelines: "Read Canvas Guidelines",
  // Browser tools — keep the names short and verb-led so the chat
  // card reads like a human action ("Click Element" instead of
  // "Browser Click"). The legacy auto-title-case produced "Browser
  // Eval", which is both jargon and an obvious foot-gun signal to the
  // user that something is wrong.
  browser_open: "Open Browser",
  browser_close: "Close Browser",
  browser_navigate: "Browse to URL",
  browser_click: "Click Element",
  browser_fill: "Fill Field",
  browser_type: "Type Keystrokes",
  browser_scroll: "Scroll Page",
  browser_screenshot: "Screenshot Page",
  browser_get_console_logs: "Read Console Logs",
  browser_page_outline: "Map Page Elements",
  browser_inspect_element: "Inspect Element State",
  browser_wait_for: "Wait for Page",
  browser_evaluate: "Run JavaScript",
  // Legacy tool names that are no longer registered with the agent —
  // kept here so historic chat threads with these in their JSONL log
  // still get a clean display label instead of a raw tool id.
  browser_eval: "Run JavaScript (legacy)",
  browser_get_dom: "Read Page HTML (legacy)",
  browser_get_url: "Read Page URL (legacy)",
  browser_list_windows: "List Browser Windows (legacy)",
};

const formatFallbackToolName = (toolName: string): string =>
  toolName
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");

export const webSearchOperation = (args: Record<string, unknown>): "fetch" | "web" | "scholar" | "images" => {
  const action = typeof args.action === "string" ? args.action.trim().toLowerCase() : "";
  const url = typeof args.url === "string" ? args.url.trim() : "";
  if (action === "fetch" || (!action && url)) return "fetch";
  const source = typeof args.source === "string" ? args.source.trim().toLowerCase() : "";
  if (source === "images") return "images";
  if (["scholar", "papers", "academic"].includes(source)) return "scholar";
  return "web";
};

export const getProfessionalToolName = (toolName: string, args?: Record<string, unknown>): string => {
  if (toolName === "auroro_websearch" && args) {
    return { fetch: Number(args.offset ?? 0) > 0 ? "Read More of Page" : "Read Web Page", web: "Search the Web", scholar: "Search Research Papers", images: "Search Images" }[webSearchOperation(args)];
  }
  if (toolName === "generate_image" && args) {
    if (args.op === "list") return "List Image Models";
    if (args.op === "edit") return "Edit Image";
    if (args.op === "generate" || (!args.op && typeof args.prompt === "string")) return "Generate Image";
  }
  if (toolName === "generate_video" && args) {
    if (args.op === "list") return "List Video Models";
    if (args.op === "query") return "Check Video Status";
    if (args.op === "generate" || (!args.op && typeof args.prompt === "string")) return "Generate Video";
  }
  if (toolName.startsWith("mcp_")) {
    return getToolDisplayName(toolName);
  }

  return TOOL_DISPLAY_NAMES[toolName] || formatFallbackToolName(toolName);
};
